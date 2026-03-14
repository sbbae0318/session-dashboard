export interface ModelPricing {
  input: number;      // $/MTok for input tokens
  output: number;     // $/MTok for output tokens
  cacheRead: number;  // $/MTok for cache read tokens
  cacheWrite: number; // $/MTok for cache write tokens
}

export type TokenType = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/**
 * Pricing table keyed by model prefix.
 * Prefix matching is used so future versions (e.g. claude-opus-4-7)
 * automatically inherit pricing from the closest prefix.
 *
 * Entries are ordered longest-prefix-first for correct matching.
 */
const MODEL_PRICING: ReadonlyArray<readonly [prefix: string, pricing: ModelPricing]> = [
  // Claude Opus 4.5 / 4.6
  ['claude-opus-4-5-20251101', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-opus-4-5', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-opus-4-6', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],

  // Claude Sonnet 4 / 4.5 / 4.6
  ['claude-sonnet-4-20250514', { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }],
  ['claude-sonnet-4-5', { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }],

  // Claude Haiku 4.5
  ['claude-haiku-4-5-20251001', { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.00 }],
  ['claude-haiku-4-5', { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.00 }],
  ['claude-haiku-4', { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.00 }],

  // OpenAI GPT-5.x
  ['gpt-5.2-codex', { input: 2.50, output: 10, cacheRead: 1.25, cacheWrite: 2.50 }],
  ['gpt-5.3-codex', { input: 2.50, output: 10, cacheRead: 1.25, cacheWrite: 2.50 }],
  ['gpt-5.2', { input: 2.50, output: 10, cacheRead: 1.25, cacheWrite: 2.50 }],
  ['gpt-5', { input: 2.50, output: 10, cacheRead: 1.25, cacheWrite: 2.50 }],

  // Free models
  ['kimi-k2.5-free', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
  ['glm-4.7-free', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],

  // Google Gemini
  ['gemini-3-pro-preview', { input: 1.25, output: 10, cacheRead: 0.315, cacheWrite: 1.25 }],
  ['gemini-3-pro', { input: 1.25, output: 10, cacheRead: 0.315, cacheWrite: 1.25 }],
  ['gemini-3-flash-preview', { input: 0.15, output: 0.60, cacheRead: 0.0375, cacheWrite: 0.15 }],
  ['gemini-3-flash', { input: 0.15, output: 0.60, cacheRead: 0.0375, cacheWrite: 0.15 }],
];

const ZERO_PRICING: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Find pricing for a model using prefix matching.
 * Returns ZERO_PRICING for unknown models (never throws).
 */
export function getModelPricing(modelId: string): ModelPricing {
  if (!modelId) return ZERO_PRICING;
  for (const [prefix, pricing] of MODEL_PRICING) {
    if (modelId.startsWith(prefix)) return pricing;
  }
  return ZERO_PRICING;
}

/**
 * Get price for a specific token type from a model.
 * Designed for use as a SQLite UDF — returns a plain number ($/MTok).
 */
export function getModelPrice(modelId: string, tokenType: TokenType): number {
  const pricing = getModelPricing(modelId);
  return pricing[tokenType];
}

export interface MessageTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Calculate cost in dollars for a single message's token usage.
 * Reasoning tokens are billed at the output rate.
 */
export function calculateMessageCost(modelId: string, tokens: MessageTokens): number {
  const pricing = getModelPricing(modelId);
  return (
    tokens.input * pricing.input +
    tokens.output * pricing.output +
    tokens.reasoning * pricing.output +
    tokens.cacheRead * pricing.cacheRead +
    tokens.cacheWrite * pricing.cacheWrite
  ) / 1_000_000;
}
