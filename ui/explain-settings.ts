/**
 * The Explain settings as the Log stores them (`superTexthooker`): the provider, its model, how hard
 * it thinks (effort) and, for OpenAI, the service tier and a price estimate. The Log's Explain and
 * the overlay's both read them here, so Explain asks the same way wherever it is asked for.
 */
export type ExplainProvider = 'codex' | 'claude' | 'kimochi' | 'openai'

/** OpenAI's model when none is chosen; must match `DEFAULT_MODEL` in src-tauri/src/reader/openai.rs. */
export const OPENAI_DEFAULT_MODEL = 'gpt-6-luna'

/** The Explain settings as the Log stores them (`superTexthooker`); defaults as in its types.ts. */
export interface ExplainSettings {
  provider: ExplainProvider
  model: string | null
  /** How hard the CLI thinks before it answers; null for its own default (and Kimochi cloud). */
  effort: string | null
  /** OpenAI's service tier (`default`, `fast` or `ultrafast`); null for the other providers. */
  tier: string | null
  prompt: unknown
  /** The instruction added for a highlighted word (`focusInstruction` in ui/explain-screen.ts);
      empty or unset: the default. */
  focusPrompt: unknown
}

export type OpenaiTier = 'default' | 'fast' | 'ultrafast'

/**
 * OpenAI's service tiers, as the settings offer them; must match `TIERS` in reader/openai.rs. Fast
 * is the default: about half Normal's wait for twice the price, which for a small model is still
 * a fraction of a cent. Ultrafast is offered only for the models that take it (`ULTRAFAST_MODELS`).
 */
export const OPENAI_TIERS: readonly { value: OpenaiTier; label: string }[] = [
  { value: 'fast', label: 'Fast (recommended)' },
  { value: 'default', label: 'Normal' },
  { value: 'ultrafast', label: 'Ultrafast' }
]

/**
 * The OpenAI models the Explain settings offer by name, cheapest first, each with a price estimate
 * (`OPENAI_PRICES`); any other can be typed in. gpt-6-luna is recommended: on the Explain prompt
 * it began writing in about a second at effort none, for a fraction of a cent.
 */
export const OPENAI_MODELS: readonly { value: string; label: string }[] = [
  { value: 'gpt-6-luna', label: 'gpt-6-luna (recommended)' },
  { value: 'gpt-6.1-terra', label: 'gpt-6.1-terra' },
  { value: 'gpt-6-sol', label: 'gpt-6-sol' },
  { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
  { value: 'gpt-6-astra', label: 'gpt-6-astra' }
]

/** Whether a stored model is one the settings list (empty is the default, gpt-6-luna). */
export function listedOpenaiModel(model: string): boolean {
  const name = model.trim() || OPENAI_DEFAULT_MODEL
  return OPENAI_MODELS.some((listed) => listed.value === name)
}

/** The models OpenAI's pricing page lists an Ultrafast tier for. */
export const ULTRAFAST_MODELS = ['gpt-6-astra', 'gpt-6.1-sol']

/** The tiers a model can be asked for: Ultrafast only where OpenAI offers it. */
export function openaiTiers(model: string | null): readonly { value: OpenaiTier; label: string }[] {
  const ultrafast = ULTRAFAST_MODELS.includes(model ?? OPENAI_DEFAULT_MODEL)
  return OPENAI_TIERS.filter((tier) => tier.value !== 'ultrafast' || ultrafast)
}

type Prices = { input: number; output: number }

/**
 * OpenAI's prices for the models Kimochi knows, in US dollars per million tokens, per tier, from
 * OpenAI's pricing page (developers.openai.com/api/docs/pricing, read 2026-11-14; short-context
 * prices). Any other model has no preview.
 */
export const OPENAI_PRICES: Record<string, { default: Prices; fast: Prices; ultrafast?: Prices }> = {
  'gpt-6-luna': { default: { input: 0.1, output: 0.5 }, fast: { input: 0.2, output: 1 } },
  'gpt-6.1-terra': { default: { input: 1, output: 5 }, fast: { input: 2, output: 10 } },
  'gpt-6-sol': { default: { input: 2, output: 10 }, fast: { input: 4, output: 20 } },
  'gpt-6.1-sol': {
    default: { input: 2, output: 10 },
    fast: { input: 4, output: 20 },
    ultrafast: { input: 12, output: 60 }
  },
  'gpt-6-astra': {
    default: { input: 10, output: 50 },
    fast: { input: 20, output: 100 },
    ultrafast: { input: 60, output: 300 }
  }
}

/**
 * What a typical explanation uses: a line with its scene and a highlighted word, measured on the
 * Explain prompt with gpt-6-luna at effort none (about 500 tokens in and 80–120 out). A model
 * that thinks, or writes at length, uses more output.
 */
const TYPICAL_TOKENS = { input: 500, output: 120 }

/**
 * An estimate of one explanation's price, in US dollars, with the model and tier chosen; null for
 * a model with no known price.
 */
export function explainPrice(model: string | null, tier: string | null): number | null {
  const known = OPENAI_PRICES[model ?? OPENAI_DEFAULT_MODEL]
  const prices = tier === 'ultrafast' ? known?.ultrafast : known?.[tier === 'default' ? 'default' : 'fast']
  if (!prices) return null
  return (TYPICAL_TOKENS.input * prices.input + TYPICAL_TOKENS.output * prices.output) / 1_000_000
}

/** A price preview's words: about how much one explanation costs, and how many a dollar buys. */
export function priceText(dollars: number): string {
  const each = dollars < 0.001 ? dollars.toPrecision(1) : dollars.toFixed(3)
  const count = 1 / dollars
  // Rounded to what the estimate can say: hundreds, tens, or ones.
  const step = count >= 1000 ? 100 : count >= 100 ? 10 : 1
  const perDollar = Math.round(count / step) * step
  const many = count >= 2 ? `, or roughly ${perDollar.toLocaleString('en-US')} explanations for $1` : ''
  return `About $${Number(each)} per explanation${many}.`
}

/**
 * The efforts each provider takes, lowest first: `claude --effort`, Codex's `model_reasoning_effort`
 * and OpenAI's `reasoning_effort` (reasoning models only). Lower answers sooner; a model that thinks
 * first shows nothing until it has (Claude Haiku thinks 3–5 s on the Explain prompt even at Low).
 * Must match `CLAUDE_EFFORTS` and `CODEX_EFFORTS` in src-tauri/src/reader/explain.rs and `EFFORTS`
 * in src-tauri/src/reader/openai.rs, which refuse others.
 */
export const EXPLAIN_EFFORTS = {
  claude: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' }
  ],
  // OpenAI's efforts, which Codex passes on: which a model takes varies (gpt-6-astra: Low to Max).
  codex: [
    { value: 'none', label: 'None' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' }
  ],
  openai: [
    // No thinking at all, the fastest. Which a model takes varies (gpt-6-astra: Low to Max).
    { value: 'none', label: 'None' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' }
  ]
} as const

/**
 * Each provider's stored model and effort settings (`superTexthooker`), and what an unset one is,
 * as the Log's defaults have it (texthooker/lib/types.ts `SETTINGS_DEFAULTS`), for a reader of the
 * stored settings without them. An effort stored empty is the model's own, chosen.
 */
const STORED = {
  claude: { model: 'explainClaudeModel', effort: 'explainClaudeEffort', fallback: 'opus', unsetEffort: '' },
  codex: { model: 'explainCodexModel', effort: 'explainCodexEffort', fallback: '', unsetEffort: '' },
  openai: { model: 'explainOpenaiModel', effort: 'explainOpenaiEffort', fallback: '', unsetEffort: 'none' }
} as const

/** A stored effort for a provider, or null: the CLI's default, Kimochi cloud's none, or one it does not take. */
export function explainEffort(provider: ExplainProvider, stored: unknown): string | null {
  if (provider === 'kimochi' || typeof stored !== 'string') return null
  return EXPLAIN_EFFORTS[provider].some((effort) => effort.value === stored) ? stored : null
}

const PROVIDERS: ExplainProvider[] = ['codex', 'claude', 'kimochi', 'openai']

/** The provider, model and effort the Log's Explain settings choose (`explainProvider`, `explain…Model`, `explain…Effort`). */
export function explainSettings(stored: unknown): ExplainSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const provider = PROVIDERS.includes(s.explainProvider as ExplainProvider)
    ? (s.explainProvider as ExplainProvider)
    : 'codex'
  const prompts = { prompt: s.explainPrompt, focusPrompt: s.explainFocusPrompt }
  if (provider === 'kimochi') return { provider, model: null, effort: null, tier: null, ...prompts }
  const keys = STORED[provider]
  const model = typeof s[keys.model] === 'string' ? (s[keys.model] as string) : keys.fallback
  const effort = explainEffort(provider, s[keys.effort] ?? keys.unsetEffort)
  const chosen = model.trim() || null
  // Fast unless another tier the model takes is chosen (Ultrafast chosen for a model that has
  // none, after switching model, is Fast too).
  const tier =
    provider === 'openai' ? (openaiTiers(chosen).find((t) => t.value === s.explainOpenaiTier)?.value ?? 'fast') : null
  return { provider, model: chosen, effort, tier, ...prompts }
}

/** How the provider is named in the Explain dialog and its settings. */
export function providerLabel(settings: ExplainSettings): string {
  if (settings.provider === 'kimochi') return 'Kimochi cloud'
  const label = EXPLAIN_EFFORTS[settings.provider].find((e) => e.value === settings.effort)?.label
  const effort = label ? ` · ${settings.effort === 'none' ? 'no thinking' : `${label.toLowerCase()} effort`}` : ''
  if (settings.provider === 'claude') return `Claude · ${settings.model ?? 'default'}${effort}`
  if (settings.provider === 'openai')
    return `OpenAI · ${settings.model ?? OPENAI_DEFAULT_MODEL}${effort}${settings.tier && settings.tier !== 'default' ? ` · ${settings.tier}` : ''}`
  return settings.model ? `Codex · ${settings.model}${effort}` : `Codex${effort}`
}
