/**
 * The Explain settings as the Log stores them (`superTexthooker`): the provider, its model and how
 * hard it thinks (effort). Read here rather than in each window, so Explain asks the same way
 * wherever it is asked for.
 */
export type ExplainProvider = 'codex' | 'claude' | 'kimochi'

/** The Explain settings as the Log stores them (`superTexthooker`); defaults as in its types.ts. */
export interface ExplainSettings {
  provider: ExplainProvider
  model: string | null
  /** How hard the CLI thinks before it answers; null for its own default (and Kimochi cloud). */
  effort: string | null
  prompt: unknown
}

/**
 * The efforts each CLI takes, lowest first: `claude --effort` and Codex's `model_reasoning_effort`.
 * Lower answers sooner; a model that thinks first shows nothing until it has (Claude Haiku thinks
 * 3–5 s on the Explain prompt even at Low). Must match `CLAUDE_EFFORTS` and `CODEX_EFFORTS` in
 * src-tauri/src/reader/explain.rs, which refuses others.
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
  ]
} as const

/**
 * Each provider's stored model and effort settings (`superTexthooker`), and what an unset one is,
 * as the Log's defaults have it (texthooker/lib/types.ts `SETTINGS_DEFAULTS`), for a reader of the
 * stored settings without them. An effort stored empty is the model's own, chosen.
 */
const STORED = {
  claude: { model: 'explainClaudeModel', effort: 'explainClaudeEffort', fallback: 'opus', unsetEffort: '' },
  codex: { model: 'explainCodexModel', effort: 'explainCodexEffort', fallback: '', unsetEffort: '' }
} as const

/** A stored effort for a provider, or null: the CLI's default, Kimochi cloud's none, or one it does not take. */
export function explainEffort(provider: ExplainProvider, stored: unknown): string | null {
  if (provider === 'kimochi' || typeof stored !== 'string') return null
  return EXPLAIN_EFFORTS[provider].some((effort) => effort.value === stored) ? stored : null
}

const PROVIDERS: ExplainProvider[] = ['codex', 'claude', 'kimochi']

/** The provider, model and effort the Log's Explain settings choose (`explainProvider`, `explain…Model`, `explain…Effort`). */
export function explainSettings(stored: unknown): ExplainSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const provider = PROVIDERS.includes(s.explainProvider as ExplainProvider)
    ? (s.explainProvider as ExplainProvider)
    : 'codex'
  if (provider === 'kimochi') return { provider, model: null, effort: null, prompt: s.explainPrompt }
  const keys = STORED[provider]
  const model = typeof s[keys.model] === 'string' ? (s[keys.model] as string) : keys.fallback
  const effort = explainEffort(provider, s[keys.effort] ?? keys.unsetEffort)
  return { provider, model: model.trim() || null, effort, prompt: s.explainPrompt }
}

/** How the provider is named in the Explain dialog and its settings. */
export function providerLabel(settings: ExplainSettings): string {
  if (settings.provider === 'kimochi') return 'Kimochi cloud'
  const label = EXPLAIN_EFFORTS[settings.provider].find((e) => e.value === settings.effort)?.label
  const effort = label ? ` · ${settings.effort === 'none' ? 'no thinking' : `${label.toLowerCase()} effort`}` : ''
  if (settings.provider === 'claude') return `Claude · ${settings.model ?? 'default'}${effort}`
  return settings.model ? `Codex · ${settings.model}${effort}` : `Codex${effort}`
}
