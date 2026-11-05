/**
 * Help → Report a bug (frontend/main/HelpDialog.tsx): what the form checks before sending. The
 * server checks the same, and more (kimochi-server API.md → Bug reports); these limits match it.
 */

export const DISCORD_URL = 'https://discord.gg/vdMge6TBZQ'

export interface BugReportDraft {
  name: string
  email: string
  description: string
  attachDebug: boolean
}

export const EMPTY_DRAFT: BugReportDraft = { name: '', email: '', description: '', attachDebug: true }
export const MIN_DESCRIPTION = 10
export const MAX_DESCRIPTION = 5000

/** The first thing keeping the draft from being sent, as a sentence; null when it can go. */
export function draftProblem(draft: BugReportDraft): string | null {
  if (!draft.name.trim()) return 'Please enter your name.'
  const email = draft.email.trim()
  if (!email) return 'Please enter your email, so we can reply.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return 'That email address doesn’t look right.'
  const description = draft.description.trim()
  if (description.length < MIN_DESCRIPTION) return 'Please describe the problem in a little more detail.'
  if (description.length > MAX_DESCRIPTION) {
    return `Please keep the description under ${MAX_DESCRIPTION.toLocaleString('en')} characters.`
  }
  return null
}
