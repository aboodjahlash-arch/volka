/**
 * @ai-agent/shared - Common types and utilities shared across all workspaces
 */

// === Provider-Agnostic LLM Types ===

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LLMMessage {
  role: LLMRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface LLMFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMGenerateOptions {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  systemInstruction?: string;
}

export interface LLMToolCall {
  id: string;
  name: string;
  args: string;
}

export interface LLMStreamChunk {
  content: string;
  toolCalls?: LLMToolCall[];
  finished: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMTelemetry {
  requestId: string;
  model: string;
  tokenUsage: TokenUsage;
  latencyMs: number;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface TokenBudgetConfig {
  maxContextTokens: number;
  maxOutputTokens: number;
  truncationStrategy: 'drop_oldest' | 'drop_system' | 'summarize' | 'fail';
  reservedTokens: number;
}

export interface LLMProviderConfig {
  model: string;
  apiKey: string;
  tokenBudget: TokenBudgetConfig;
  baseUrl?: string;
}

export interface LLMProvider {
  readonly name: string;
  generate(options: LLMGenerateOptions): Promise<{ content: string; telemetry: LLMTelemetry }>;
  stream(options: LLMGenerateOptions): AsyncIterable<LLMStreamChunk>;
  countTokens(messages: LLMMessage[]): Promise<number>;
  getTelemetry(): LLMTelemetry[];
}

export interface LLMProviderFactory {
  createProvider(config?: Partial<LLMProviderConfig>): LLMProvider;
}

// === Agent Core Types ===

export type AgentToolCategory = 'filesystem' | 'shell' | 'git' | 'search' | 'code_analysis' | 'test';

export type AgentPermissionLevel = 'safe' | 'confirm_required' | 'forbidden';

export interface AgentTool {
  name: string;
  description: string;
  category: AgentToolCategory;
  permissionLevel: AgentPermissionLevel;
  execute(input: Record<string, unknown>): Promise<AgentToolResult>;
}

export interface AgentToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentAction {
  tool: string;
  input: Record<string, unknown>;
  timestamp: number;
  result?: AgentToolResult;
}

export interface AgentExecutionTrace {
  id: string;
  task: string;
  actions: AgentAction[];
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

export interface AgentPlannerConfig {
  maxSteps: number;
  maxConsecutiveFailures: number;
  verificationEnabled: boolean;
}

// === Workspace Index Types ===

export interface WorkspaceFile {
  path: string;
  language: string;
  size: number;
  lastModified: number;
  symbols: SymbolInfo[];
  imports: string[];
  exports: string[];
}

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'property';
  startLine: number;
  endLine: number;
  filePath: string;
}

export interface DependencyGraph {
  nodes: Map<string, Set<string>>;
  edges: Array<{ from: string; to: string; type: 'import' | 'require' | 'dynamic' }>;
}

// === Vibe Coding Types ===

export type EditScope = 'selection' | 'file' | 'workspace';

export interface DiffEdit {
  filePath: string;
  original: string;
  modified: string;
  diff: string;
  accepted: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  edits?: DiffEdit[];
}

export interface ConversationSession {
  id: string;
  projectPath: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// === Sandbox Types ===

export interface SandboxConfig {
  image: string;
  cpuLimit: number;
  memoryLimit: number;
  timeout: number;
  workingDirectory: string;
  environmentVariables: Record<string, string>;
}

export interface SandboxSession {
  id: string;
  config: SandboxConfig;
  createdAt: number;
  status: 'creating' | 'running' | 'stopped' | 'failed';
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

// === Permission Model ===

export interface PermissionRequest {
  action: string;
  tool: string;
  details: string;
  timestamp: number;
  resolved: boolean;
  granted?: boolean;
}

export interface AutonomousModeConfig {
  enabled: boolean;
  scopeLimits: {
    allowedDirectories: string[];
    allowedCommands: string[];
    maxExecutionTime: number;
  };
}

// === Observability Types ===

export interface TelemetryEvent {
  type: string;
  timestamp: number;
  duration?: number;
  tokensUsed?: number;
  toolCalls?: number;
  success?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface StructuredLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
  context?: Record<string, unknown>;
  error?: Error;
}
