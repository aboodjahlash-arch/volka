/**
 * @ai-agent/agent-core/providers/gemini-provider
 *
 * Gemini 2.5 Flash LLM provider implementation using the @google/genai SDK.
 * Supports:
 *   (a) streaming via client.models.generateContentStream()
 *   (b) function calling via Gemini's FunctionDeclaration schema
 *   (c) token-budget management with context window packing and truncation
 *   (d) cost/latency telemetry per request
 */

import { GoogleGenAI } from '@google/genai';
import type {
  LLMProvider,
  LLMProviderConfig,
  LLMGenerateOptions,
  LLMMessage,
  LLMStreamChunk,
  LLMToolCall,
  TokenUsage,
  LLMTelemetry,
  TokenBudgetConfig,
} from '@ai-agent/shared';

// Token estimation constants
const TOKENS_PER_CHAR = 0.25;
const TOKENS_PER_MESSAGE_OVERHEAD = 4;

// Default token budget for Gemini 2.5 Flash (1M context window)
const DEFAULT_TOKEN_BUDGET: TokenBudgetConfig = {
  maxContextTokens: 1_048_576,
  maxOutputTokens: 8192,
  truncationStrategy: 'drop_oldest',
  reservedTokens: 1024,
};

// Cost per million tokens (Gemini 2.5 Flash pricing as of 2025)
const COST_PER_1M_INPUT_TOKENS = 0.15;
const COST_PER_1M_OUTPUT_TOKENS = 0.60;

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokenCount(msg.content) + TOKENS_PER_MESSAGE_OVERHEAD;
  }
  return total;
}

function truncateMessages(
  messages: LLMMessage[],
  maxTokens: number,
  strategy: TokenBudgetConfig['truncationStrategy'],
): LLMMessage[] {
  const estimated = estimateMessagesTokens(messages);
  if (estimated <= maxTokens) return messages;

  switch (strategy) {
    case 'drop_oldest': {
      const systemMessages = messages.filter((m) => m.role === 'system');
      const nonSystem = messages.filter((m) => m.role !== 'system');
      const truncated: LLMMessage[] = [...systemMessages];
      let currentTokens = estimateMessagesTokens(truncated);

      for (const msg of nonSystem.slice().reverse()) {
        const msgTokens = estimateTokenCount(msg.content) + TOKENS_PER_MESSAGE_OVERHEAD;
        if (currentTokens + msgTokens <= maxTokens) {
          truncated.push(msg);
          currentTokens += msgTokens;
        } else {
          const availableTokens = maxTokens - currentTokens - TOKENS_PER_MESSAGE_OVERHEAD;
          if (availableTokens > 0) {
            const maxChars = Math.floor(availableTokens / TOKENS_PER_CHAR);
            truncated.push({
              ...msg,
              content: msg.content.slice(0, maxChars) + '\n[truncated]',
            });
          }
          break;
        }
      }
      return truncated;
    }

    case 'drop_system': {
      const nonSystem = messages.filter((m) => m.role !== 'system');
      const truncated: LLMMessage[] = [];
      let currentTokens = 0;
      for (const msg of nonSystem.slice().reverse()) {
        const msgTokens = estimateTokenCount(msg.content) + TOKENS_PER_MESSAGE_OVERHEAD;
        if (currentTokens + msgTokens <= maxTokens) {
          truncated.unshift(msg);
          currentTokens += msgTokens;
        } else {
          const availableTokens = maxTokens - currentTokens - TOKENS_PER_MESSAGE_OVERHEAD;
          if (availableTokens > 0) {
            const maxChars = Math.floor(availableTokens / TOKENS_PER_CHAR);
            truncated.unshift({
              ...msg,
              content: msg.content.slice(0, maxChars) + '\n[truncated]',
            });
          }
          break;
        }
      }
      return truncated;
    }

    case 'summarize': {
      if (messages.length <= 4) return messages;
      const keepFirst = 2;
      const keepLast = 2;
      return [
        ...messages.slice(0, keepFirst),
        {
          role: 'system' as const,
          content: `[${messages.length - keepFirst - keepLast} messages omitted for token budget]`,
        },
        ...messages.slice(-keepLast),
      ];
    }

    case 'fail':
    default:
      throw new Error(
        `Token budget exceeded: estimated ${estimated} tokens, max ${maxTokens} tokens. ` +
        'Reduce message size or increase maxContextTokens.',
      );
  }
}

/**
 * Gemini 2.5 Flash LLM Provider
 *
 * Uses the @google/genai SDK for both streaming and non-streaming generation.
 * Implements token-budget management, function calling, and full telemetry.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini-2.5-flash';

  private client: GoogleGenAI;
  private config: LLMProviderConfig;
  private telemetryLog: LLMTelemetry[] = [];
  private requestCounter = 0;

  constructor(config?: Partial<LLMProviderConfig>) {
    const apiKey = config?.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set. Provide it in config or set the GEMINI_API_KEY environment variable.',
      );
    }

    this.config = {
      model: config?.model ?? 'gemini-2.5-flash',
      apiKey,
      tokenBudget: { ...DEFAULT_TOKEN_BUDGET, ...config?.tokenBudget },
      baseUrl: config?.baseUrl,
    };

    this.client = new GoogleGenAI({ apiKey: this.config.apiKey });
  }

  async countTokens(messages: LLMMessage[]): Promise<number> {
    return estimateMessagesTokens(messages);
  }

  /**
   * Generate a non-streaming response from Gemini.
   * Returns both content and telemetry data.
   */
  async generate(
    options: LLMGenerateOptions,
  ): Promise<{ content: string; telemetry: LLMTelemetry }> {
    const requestId = `gen-${++this.requestCounter}-${Date.now()}`;
    const startTime = performance.now();

    try {
      const budget = this.config.tokenBudget;
      const availableTokens = budget.maxContextTokens - budget.reservedTokens - budget.maxOutputTokens;
      const truncatedMessages = truncateMessages(
        options.messages,
        availableTokens,
        budget.truncationStrategy,
      );

      const systemInstruction = options.systemInstruction ??
        truncatedMessages.find((m) => m.role === 'system')?.content;
      const nonSystemMessages = truncatedMessages.filter((m) => m.role !== 'system');

      // Convert messages to Gemini SDK format
      const geminiContents = this.convertMessagesToGeminiContents(nonSystemMessages);

      // Convert tools to Gemini FunctionDeclaration format
      const tools = options.tools?.length
        ? [{ functionDeclarations: options.tools.map((t) => this.convertToolToFunctionDeclaration(t)) }]
        : undefined;

      // Make the API call using the SDK
      const response = await this.client.models.generateContent({
        model: this.config.model,
        contents: geminiContents as [{ role?: string; parts: Array<Record<string, unknown>> }],
        config: {
          systemInstruction: systemInstruction ? { text: systemInstruction } : undefined,
          tools: tools as Array<Record<string, unknown>>,
          maxOutputTokens: options.maxTokens ?? budget.maxOutputTokens,
          temperature: options.temperature ?? 0.2,
          stopSequences: options.stopSequences,
        },
      });

      const latencyMs = Math.round(performance.now() - startTime);

      // Extract text from response
      const content = response.text ?? '';

      // Build telemetry with usage metadata if available
      const usage = (response as unknown as {
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      }).usageMetadata;

      const tokenUsage: TokenUsage = {
        promptTokens: usage?.promptTokenCount ?? estimateTokenCount(
          JSON.stringify(nonSystemMessages),
        ),
        completionTokens: usage?.candidatesTokenCount ?? estimateTokenCount(content),
        totalTokens: usage?.totalTokenCount ?? 0,
      };

      const telemetry: LLMTelemetry = {
        requestId,
        model: this.config.model,
        tokenUsage,
        latencyMs,
        timestamp: Date.now(),
        success: true,
      };

      this.telemetryLog.push(telemetry);
      return { content, telemetry };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const errorMessage = error instanceof Error ? error.message : String(error);

      const telemetry: LLMTelemetry = {
        requestId,
        model: this.config.model,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs,
        timestamp: Date.now(),
        success: false,
        error: errorMessage,
      };

      this.telemetryLog.push(telemetry);
      throw error;
    }
  }

  /**
   * Stream a response from Gemini using the SDK's generateContentStream.
   * Yields content chunks and function calls as they arrive from the API.
   * Records telemetry on completion with token usage and latency.
   */
  async *stream(options: LLMGenerateOptions): AsyncIterable<LLMStreamChunk> {
    const requestId = `stream-${++this.requestCounter}-${Date.now()}`;
    const startTime = performance.now();

    try {
      const budget = this.config.tokenBudget;
      const availableTokens = budget.maxContextTokens - budget.reservedTokens - budget.maxOutputTokens;
      const truncatedMessages = truncateMessages(
        options.messages,
        availableTokens,
        budget.truncationStrategy,
      );

      const systemInstruction = options.systemInstruction ??
        truncatedMessages.find((m) => m.role === 'system')?.content;
      const nonSystemMessages = truncatedMessages.filter((m) => m.role !== 'system');

      // Convert messages to Gemini SDK format
      const geminiContents = this.convertMessagesToGeminiContents(nonSystemMessages);

      // Convert tools to Gemini FunctionDeclaration format
      const tools = options.tools?.length
        ? [{ functionDeclarations: options.tools.map((t) => this.convertToolToFunctionDeclaration(t)) }]
        : undefined;

      // Use the SDK's streaming API - returns AsyncGenerator<GenerateContentResponse>
      const stream = await this.client.models.generateContentStream({
        model: this.config.model,
        contents: geminiContents as [{ role?: string; parts: Array<Record<string, unknown>> }],
        config: {
          systemInstruction: systemInstruction ? { text: systemInstruction } : undefined,
          tools: tools as Array<Record<string, unknown>>,
          maxOutputTokens: options.maxTokens ?? budget.maxOutputTokens,
          temperature: options.temperature ?? 0.2,
          stopSequences: options.stopSequences,
        },
      });

      let fullContent = '';
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;

      // Iterate over each chunk from the stream
      for await (const chunk of stream) {
        const chunkText = chunk.text ?? '';
        fullContent += chunkText;

        // Extract function calls if present in this chunk
        const chunkFunctionCalls = chunk.functionCalls;
        const toolCalls: LLMToolCall[] = [];

        if (chunkFunctionCalls && chunkFunctionCalls.length > 0) {
          for (let idx = 0; idx < chunkFunctionCalls.length; idx++) {
            const fc = chunkFunctionCalls[idx];
            toolCalls.push({
              id: `fc-${requestId}-${idx}`,
              name: fc.name ?? 'unknown',
              args: JSON.stringify(fc.args ?? {}),
            });
          }
        }

        // Extract usage metadata from the chunk if available
        const usage = (chunk as unknown as {
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            totalTokenCount?: number;
          };
        }).usageMetadata;

        if (usage) {
          totalPromptTokens = usage.promptTokenCount ?? totalPromptTokens;
          totalCompletionTokens = usage.candidatesTokenCount ?? totalCompletionTokens;
        }

        yield {
          content: chunkText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finished: false,
        };
      }

      // Record telemetry after stream completes
      const latencyMs = Math.round(performance.now() - startTime);
      const telemetry: LLMTelemetry = {
        requestId,
        model: this.config.model,
        tokenUsage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
        },
        latencyMs,
        timestamp: Date.now(),
        success: true,
      };

      this.telemetryLog.push(telemetry);
      yield { content: '', finished: true };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const errorMessage = error instanceof Error ? error.message : String(error);

      const telemetry: LLMTelemetry = {
        requestId,
        model: this.config.model,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs,
        timestamp: Date.now(),
        success: false,
        error: errorMessage,
      };

      this.telemetryLog.push(telemetry);
      throw error;
    }
  }

  /**
   * Get all accumulated telemetry entries.
   */
  getTelemetry(): LLMTelemetry[] {
    return [...this.telemetryLog];
  }

  /**
   * Get cost estimate for a given token usage.
   * Based on Gemini 2.5 Flash pricing:
   *   - Input: $0.15 per 1M tokens
   *   - Output: $0.60 per 1M tokens
   */
  static estimateCost(tokenUsage: TokenUsage): {
    inputCost: number;
    outputCost: number;
    totalCost: number;
  } {
    const inputCost = (tokenUsage.promptTokens / 1_000_000) * COST_PER_1M_INPUT_TOKENS;
    const outputCost = (tokenUsage.completionTokens / 1_000_000) * COST_PER_1M_OUTPUT_TOKENS;
    return {
      inputCost: Math.round(inputCost * 100000) / 100000,
      outputCost: Math.round(outputCost * 100000) / 100000,
      totalCost: Math.round((inputCost + outputCost) * 100000) / 100000,
    };
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Convert LLMMessage[] to Gemini SDK content format.
   * Maps roles: 'assistant' -> 'model', 'tool' -> 'tool', 'user' -> 'user'.
   * System messages are excluded (handled via systemInstruction config).
   * Tool response messages include functionResponse parts.
   */
  private convertMessagesToGeminiContents(
    messages: LLMMessage[],
  ): Array<{
    role: string;
    parts: Array<{
      text?: string;
      functionCall?: Record<string, unknown>;
      functionResponse?: Record<string, unknown>;
    }>;
  }> {
    const contents: Array<{
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: Record<string, unknown>;
        functionResponse?: Record<string, unknown>;
      }>;
    }> = [];

    for (const msg of messages) {
      // Skip system messages - they are handled via systemInstruction config
      if (msg.role === 'system') {
        continue;
      }

      const parts: Array<{
        text?: string;
        functionCall?: Record<string, unknown>;
        functionResponse?: Record<string, unknown>;
      }> = [];

      // Add text content if present
      if (msg.content) {
        parts.push({ text: msg.content });
      }

      // If this is a tool response, add functionResponse part
      if (msg.toolCallId && msg.toolName) {
        parts.push({
          functionResponse: {
            name: msg.toolName,
            response: { content: msg.content },
          },
        });
      }

      // Map LLM roles to Gemini roles
      let geminiRole: string;
      switch (msg.role) {
        case 'assistant':
          geminiRole = 'model';
          break;
        case 'tool':
          geminiRole = 'tool';
          break;
        case 'user':
        default:
          geminiRole = 'user';
          break;
      }

      contents.push({ role: geminiRole, parts });
    }

    return contents;
  }

  /**
   * Convert an LLMToolDefinition to a Gemini FunctionDeclaration.
   * Maps JSON Schema types to Gemini's type system (STRING, NUMBER, INTEGER,
   * BOOLEAN, OBJECT, ARRAY).
   */
  private convertToolToFunctionDeclaration(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description,
      parameters: this.convertJsonSchemaToGeminiSchema(tool.parameters),
    };
  }

  /**
   * Recursively convert a JSON Schema object to Gemini's schema format.
   * Gemini uses uppercase type names (STRING, NUMBER, etc.) and expects
   * nested objects/arrays to be fully expanded.
   */
  private convertJsonSchemaToGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') {
      return { type: 'STRING' };
    }

    const s = schema as Record<string, unknown>;
    const rawType = (s.type as string) ?? 'string';
    const type = rawType.toUpperCase();

    // Map JSON Schema types to Gemini types
    const geminiTypeMap: Record<string, string> = {
      STRING: 'STRING',
      NUMBER: 'NUMBER',
      INTEGER: 'INTEGER',
      BOOLEAN: 'BOOLEAN',
      OBJECT: 'OBJECT',
      ARRAY: 'ARRAY',
    };

    const geminiType = geminiTypeMap[type] ?? 'STRING';

    if (type === 'OBJECT') {
      const properties = s.properties as Record<string, unknown> | undefined;
      const required = s.required as string[] | undefined;
      const result: Record<string, unknown> = { type: geminiType };

      if (properties) {
        const convertedProperties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(properties)) {
          convertedProperties[key] = this.convertJsonSchemaToGeminiSchema(
            value as Record<string, unknown>,
          );
        }
        result.properties = convertedProperties;
      }

      if (required && required.length > 0) {
        result.required = required;
      }

      // Include description if present
      if (s.description) {
        result.description = s.description;
      }

      return result;
    }

    if (type === 'ARRAY') {
      const items = s.items as Record<string, unknown> | undefined;
      const result: Record<string, unknown> = {
        type: geminiType,
        items: items ? this.convertJsonSchemaToGeminiSchema(items) : { type: 'STRING' },
      };

      if (s.description) {
        result.description = s.description;
      }

      return result;
    }

    // Primitive type
    const result: Record<string, unknown> = { type: geminiType };
    if (s.description) {
      result.description = s.description;
    }
    if (s.enum) {
      result.enum = s.enum;
    }

    return result;
  }
}

/**
 * Default token budget configuration for Gemini 2.5 Flash.
 * Supports up to 1,048,576 tokens in context window with 8,192 output tokens.
 */
export const DEFAULT_GEMINI_CONFIG: Partial<LLMProviderConfig> = {
  model: 'gemini-2.5-flash',
  tokenBudget: DEFAULT_TOKEN_BUDGET,
};
