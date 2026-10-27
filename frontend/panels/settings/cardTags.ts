/**
 * Card enhancement's tags as a card gets them, for Settings → Anki → Card enhancement's preview:
 * the same rule as `card_tags::tags` in Rust, which tags the cards.
 */
export const SESSION_NAME = '{{session-name}}'

/** The tags in `template` (comma-separated), `{{session-name}}` replaced by `session`; spaces
    become `_` (Anki splits tags at spaces), a name's `::` becomes `:` (Anki nests tags at `::`),
    and an empty tag or a repeat is dropped. */
export function cardTags(template: string, session: string | null): string[] {
  let name = session ?? ''
  while (name.includes('::')) name = name.replaceAll('::', ':')
  const out: string[] = []
  for (const part of template.split(',')) {
    const tag = part
      .replaceAll(SESSION_NAME, name)
      .split(/\s+/)
      .filter(Boolean)
      .join('_')
      .replace(/^_+|_+$/g, '')
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag)
  }
  return out
}
