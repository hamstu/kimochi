/**
 * Help → Report a bug / Request a feature (frontend/main/HelpDialog.tsx): what the forms check
 * before sending. The server checks the same, and more (kimochi-server API.md → Bug reports);
 * these limits match it.
 */

export const DISCORD_URL = 'https://discord.gg/vdMge6TBZQ'

export type ReportKind = 'bug' | 'feature'

/** Both forms share who's writing; each keeps its own text. */
export interface BugReportDraft {
  name: string
  email: string
  /** The bug report's "What happened?". */
  description: string
  /** The feature request's "What would you like?". */
  idea: string
  attachDebug: boolean
}

export const EMPTY_DRAFT: BugReportDraft = { name: '', email: '', description: '', idea: '', attachDebug: true }

/** The text the form of this kind is editing. */
export const draftText = (draft: BugReportDraft, kind: ReportKind): string =>
  kind === 'feature' ? draft.idea : draft.description
export const MIN_DESCRIPTION = 10
export const MAX_DESCRIPTION = 5000

/** The first thing keeping the draft from being sent, as a sentence; null when it can go. */
export function draftProblem(draft: BugReportDraft, kind: ReportKind = 'bug'): string | null {
  if (!draft.name.trim()) return 'Please enter your name.'
  const email = draft.email.trim()
  if (!email) return 'Enter your email so I can reply.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return 'That email address doesn’t look right.'
  const description = draftText(draft, kind).trim()
  if (description.length < MIN_DESCRIPTION) {
    return `Please describe ${kind === 'feature' ? 'your idea' : 'the problem'} in a little more detail.`
  }
  if (description.length > MAX_DESCRIPTION) {
    return `Please keep the description under ${MAX_DESCRIPTION.toLocaleString('en')} characters.`
  }
  return null
}
