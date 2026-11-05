/**
 * Help → Report a bug / Request a feature (`bug_report_send`; COMMANDS.md → Bug reports). Native
 * builds the debug bundle (bugs only) and posts the report to the Kimochi server, which emails it
 * to the maintainer.
 */
import { invoke } from '@tauri-apps/api/core'

export interface BugReportInput {
  /** `bug` when omitted. A feature request never carries debug data. */
  kind?: 'bug' | 'feature'
  name: string
  email: string
  description: string
  /** The debug page's Markdown (`ui/debug-report.ts`); omitted, no debug data is sent. */
  debugMarkdown?: string
}

/** Resolves to the server's reference for the report; rejects with a sentence for the reporter. */
export const sendBugReport = (report: BugReportInput): Promise<{ id: string | null }> =>
  invoke('bug_report_send', { report })
