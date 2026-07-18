/**
 * @ai-agent/agent-core/providers/provider-factory
 *
 * LLM Provider Factory that creates provider instances based on configuration.
 * Reads GEMINI_API_KEY from environment variable or configuration.
 */

import type { LLMProvider, LLMProviderConfig } from '@ai-agent/shared';
import { GeminiProvider, DEFAULT_GEMINI_CONFIG } from './gemini-provider.js';

export type ProviderType = 'gemini' | 'openai' | 'anthropic';

export interface ProviderFactoryOptions {
  type?: ProviderType;
  config?: Partial<LLMProviderConfig>;
  apiKey?: string;
  model?: string;
}

/**
 * LLMProviderFactory - Creates LLM provider instances.
 *
 * Defaults to Gemini 2.5 Flash. Reads GEMINI_API_KEY from:
 * 1. options.apiKey (explicit parameter)
 * 2. process.env.GEMINI_API_KEY
 * 3. Falls back to empty string (provider will throw on construction)
 *
 * For VS Code integration, the extension should set process.env.GEMINI_API_KEY
 * from the VS Code settings before calling createProvider().
 */
export class LLMProviderFactory {
  private defaultType: ProviderType;

  constructor(defaultType: ProviderType = 'gemini') {
    this.defaultType = defaultType;
  }

  /**
   * Create an LLM provider instance.
   *
   * @param options - Provider configuration options
   * @returns An LLMProvider instance
   * @throws Error if the provider type is unknown or configuration is invalid
   */
  createProvider(options?: ProviderFactoryOptions): LLMProvider {
    const type = options?.type ?? this.defaultType;
    const mergedConfig: Partial<LLMProviderConfig> = {
      ...this.getDefaultConfig(type),
      ...options?.config,
    };

    // Override apiKey if explicitly provided
    if (options?.apiKey) {
      mergedConfig.apiKey = options.apiKey;
    }

    // Override model if explicitly provided
    if (options?.model) {
      mergedConfig.model = options.model;
    }

    switch (type) {
      case 'gemini':
        return new GeminiProvider(mergedConfig);
      default:
        throw new Error(
          `Unknown provider type: ${type}. Supported types: ${this.getSupportedTypes().join(', ')}`,
        );
    }
  }

  /**
   * Get the list of supported provider types.
   */
  getSupportedTypes(): ProviderType[] {
    return ['gemini'];
  }

  /**
   * Set the default provider type for subsequent factory calls.
   */
  setDefaultType(type: ProviderType): void {
    this.defaultType = type;
  }

  private getDefaultConfig(type: ProviderType): Partial<LLMProviderConfig> | undefined {
    switch (type) {
      case 'gemini':
        return DEFAULT_GEMINI_CONFIG;
      default:
        return undefined;
    }
  }
}

/**
 * Convenience function to create a Gemini provider with a single call.
 * Reads GEMINI_API_KEY from environment variable by default.
 *
 * @param apiKey - Optional API key override
 * @param model - Optional model override (defaults to gemini-2.5-flash)
 * @returns A configured GeminiProvider instance
 */
export function createGeminiProvider(
  apiKey?: string,
  model?: string,
): GeminiProvider {
  const factory = new LLMProviderFactory();
  const provider = factory.createProvider({
    type: 'gemini',
    apiKey,
    model,
  });
  return provider as GeminiProvider;
}

/**
 * Get the current Gemini API key from environment or VS Code settings.
 * For VS Code, the extension should set process.env.GEMINI_API_KEY before
 * calling this function.
 */
export function resolveApiKey(customKey?: string): string {
  if (customKey) return customKey;
  const envKey = process.env['GEMINI_API_KEY'];
  if (envKey) return envKey;
  return '';
}
