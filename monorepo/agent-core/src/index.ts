/**
 * @ai-agent/agent-core - Agent runtime with planner-executor loop, LLM integration, and tool system
 *
 * Re-exports all agent-core modules including providers.
 */

export { AgentCore } from './agent-core.js';
export { GeminiProvider, DEFAULT_GEMINI_CONFIG } from './providers/gemini-provider.js';
export { LLMProviderFactory, createGeminiProvider, resolveApiKey } from './providers/provider-factory.js';
export type { ProviderType, ProviderFactoryOptions } from './providers/provider-factory.js';
