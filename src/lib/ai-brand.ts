import type { LocalAgentId } from './agents'
import type { AIBackend, AIProviderId } from './ai'

export type AIBrandId = AIBackend | AIProviderId | LocalAgentId

/** Infers the model-family brand for multi-provider catalogs (e.g. OpenRouter, Groq, Ollama). */
export function inferModelBrand(modelId: string, fallback: AIBrandId): AIBrandId {
  const lower = modelId.trim().toLowerCase()
  if (!lower) return fallback
  if (lower.startsWith('openai/') || /^(gpt-|o1|o3|o4|codex)/.test(lower)) return 'openai'
  if (lower.startsWith('anthropic/') || lower.includes('claude') || /^(sonnet|opus|haiku|fable)/.test(lower)) return 'anthropic'
  if (lower.startsWith('google/') || lower.includes('gemini')) return 'gemini'
  if (lower.startsWith('swe-') || lower === 'adaptive') return 'devin-cli'
  if (lower.startsWith('deepseek/') || lower.startsWith('deepseek-ai/') || lower.includes('deepseek')) return 'deepseek'
  if (lower.startsWith('x-ai/') || lower.includes('grok')) return 'xai'
  if (lower.startsWith('qwen/') || lower.startsWith('qwen')) return 'qwen'
  if (lower.includes('glm-')) return 'zhipu'
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'moonshot'
  if (lower.includes('doubao')) return 'volcengine'
  if (lower.includes('minimax')) return 'minimax'
  return fallback
}
