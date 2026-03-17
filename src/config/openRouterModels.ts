/**
 * src/config/openRouterModels.ts
 * Curated list of vision-capable models available on OpenRouter.
 * Updated: March 2026
 *
 * Selection criteria:
 * - Must support vision/image input
 * - Must support structured JSON output (for compliance verdicts)
 * - Prioritized by: quality for BIM/architecture analysis, cost-efficiency, speed
 * - Covers multiple providers for redundancy
 *
 * @module openRouterModels
 */

export interface OpenRouterModelOption {
  /** OpenRouter model ID (e.g., "anthropic/claude-sonnet-4") */
  id: string;
  /** Human-readable display name */
  label: string;
  /** Provider name */
  provider: string;
  /** Brief description of strengths */
  description: string;
  /** Whether this is the recommended default */
  isDefault?: boolean;
}

/**
 * Curated vision-capable models on OpenRouter.
 *
 * Why these models:
 * 1. Claude Sonnet 4 — Best overall vision reasoning, excellent at spatial analysis & BIM
 * 2. GPT-4o — Strong multimodal, fast, good structured output
 * 3. Claude 3.5 Sonnet — Proven architecture/engineering vision analysis
 * 4. Gemini 2.5 Flash — Fast, cost-effective, good vision with thinking
 * 5. GPT-4.1 — Latest OpenAI, strong vision + JSON mode
 * 6. Gemini 2.5 Pro — Google's best, deep reasoning with vision
 * 7. GPT-4o mini — Budget-friendly, still capable for simpler checks
 * 8. Claude 3.5 Haiku — Fast & cheap Anthropic option
 * 9. Llama 4 Maverick — Open-source, strong multimodal from Meta
 * 10. Qwen 2.5 VL 72B — Open-source vision specialist from Alibaba
 */
export const OPENROUTER_VISION_MODELS: OpenRouterModelOption[] = [
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    provider: "Anthropic",
    description: "Strong multimodal reasoning with reliable long responses. Good for detailed visual inspection and explanation.",
  },
  {
    id: "openai/gpt-5.4",
    label: "GPT-5.4",
    provider: "OpenAI",
    description: "Balanced multimodal model with stable structured outputs. Suitable for general visual analysis and compliance checks.",
  },
  {
    id: "anthropic/claude-opus-4.6",
    label: "Claude Opus 4.6",
    provider: "Anthropic",
    description: "Large high-capability model optimized for complex reasoning tasks. Useful for difficult compliance evaluations but slower and costly.",
  },
  {
    id: "x-ai/grok-4.20-multi-agent-beta",
    label: "Grok 4.20",
    provider: "X.AI",
    description: "Multimodal reasoning model designed for fast responses and tool-style workflows. Suitable for experimentation in agent pipelines.",
  },
  {
    id: "openai/gpt-5.4-pro",
    label: "GPT-5.4 Pro",
    provider: "OpenAI",
    description: "High-capability multimodal model with strong reasoning and reliable structured outputs. Good for complex compliance evaluation tasks.",
  },
  {
    id: "openrouter/hunter-alpha",
    label: "Hunter Alpha",
    provider: "OpenRouter",
    description: "Experimental large multimodal model focused on reasoning-heavy tasks. Suitable for exploratory testing but may vary in stability.",
  },
  {
    id: "moonshotai/kimi-k2.5",
    label: "Kimi K2.5",
    provider: "Moonshot AI",
    description: "Efficient multimodal model optimized for long contexts and cost efficiency. Suitable for simpler visual checks.",
  },
  {
    id: "amazon/nova-2-lite-v1",
    label: "Nova 2 Lite",
    provider: "Amazon",
    description: "Lightweight multimodal model designed for speed and low cost. Useful for rapid screening rather than detailed analysis.",
  },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite",
    provider: "Google",
    description: "Fast multimodal model optimized for low latency. Suitable for quick visual analysis in large batch evaluations.",
  },
  {
    id: "qwen/qwen3.5-9b",
    label: "Qwen 3.5 9B",
    provider: "Alibaba",
    description: "Compact open-source multimodal model suitable for experimentation and local deployment. Limited reasoning capacity compared to larger models.",
  },
];

/**
 * Get the default model
 */
export function getDefaultModel(): OpenRouterModelOption {
  return OPENROUTER_VISION_MODELS.find((m) => m.isDefault) ?? OPENROUTER_VISION_MODELS[0];
}

/**
 * Find a model by ID
 */
export function findModelById(id: string): OpenRouterModelOption | undefined {
  return OPENROUTER_VISION_MODELS.find((m) => m.id === id);
}
