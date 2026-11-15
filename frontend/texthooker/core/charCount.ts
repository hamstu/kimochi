/**
 * Characters read, counted the way the Japanese reading trackers count them (GameSentenceMiner,
 * exSTATic, Rubi): every character but punctuation, symbols, spaces and line breaks, each counted
 * once (code points, so a rare kanji outside the BMP is one character, not two).
 * `count_chars` in src-tauri/src/reading_history.rs is the same rule; keep them together.
 *
 * GSM removes `\p{P}\p{S}\p{Z}` (it also counts the line breaks inside a line, which this does
 * not); exSTATic removes a list of Japanese punctuation, which leaves `!`, `・`, `〜` and emoji in.
 * For Japanese text the three agree within a few characters a page.
 */
const NOT_READ = /[\p{P}\p{S}\p{Z}\p{Cc}]/gu

/** How many characters of `text` count as read. */
export function countChars(text: string): number {
  let count = 0
  for (const _ of text.replace(NOT_READ, '')) count += 1
  return count
}
