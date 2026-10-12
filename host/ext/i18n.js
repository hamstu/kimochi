/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/**
 * `chrome.i18n` over the extension's own `_locales/<lang>/messages.json` (§5.3).
 *
 * 10ten calls `getMessage` synchronously for every string it renders, from its content script,
 * its background (toolbar titles) and its options page, so the table has to be in memory before
 * any of that code runs. Extension-origin documents load it synchronously at document start (the
 * options page's own script tag runs right after this host and cannot be delayed); app documents
 * load it asynchronously before the host injects the content scripts. Hachidori has no
 * `default_locale` and never calls it, so it gets an empty table.
 */

/** `en-US` → `['en_US', 'en', <default_locale>]`, as Chrome falls back. */
export function localeCandidates(language, defaultLocale) {
  if (!defaultLocale) return []
  const lang = String(language || '').replace(/-/g, '_')
  const base = lang.split('_')[0]
  return [...new Set([lang, base, defaultLocale].filter(Boolean))]
}

function table(raw, locale) {
  const messages = {}
  for (const [key, value] of Object.entries(raw ?? {})) messages[key.toLowerCase()] = value
  return { messages, locale }
}

export function loadMessagesSync(origin, manifest, win = window) {
  for (const locale of localeCandidates(win.navigator?.language, manifest.default_locale)) {
    try {
      const xhr = new win.XMLHttpRequest()
      xhr.open('GET', `${origin}/_locales/${locale}/messages.json`, false)
      xhr.send()
      if (xhr.status === 200) return table(JSON.parse(xhr.responseText), locale)
    } catch {
      // Next candidate.
    }
  }
  return table({}, manifest.default_locale ?? 'en')
}

export async function loadMessages(origin, manifest, win = window) {
  for (const locale of localeCandidates(win.navigator?.language, manifest.default_locale)) {
    try {
      const response = await win.fetch(`${origin}/_locales/${locale}/messages.json`)
      if (response.ok) return table(await response.json(), locale)
    } catch {
      // Next candidate.
    }
  }
  return table({}, manifest.default_locale ?? 'en')
}

/** Chrome's `getMessage`: `$name$` placeholders, then `$1`…`$9`, `$$` for a dollar sign. */
export function getMessage(state, extensionId, name, substitutions) {
  const key = String(name ?? '').toLowerCase()
  const locale = state?.locale ?? 'en'
  const predefined = {
    '@@extension_id': extensionId,
    '@@ui_locale': locale,
    '@@bidi_dir': 'ltr',
    '@@bidi_reversed_dir': 'rtl',
    '@@bidi_start_edge': 'left',
    '@@bidi_end_edge': 'right'
  }
  if (key in predefined) return predefined[key]
  const entry = state?.messages?.[key]
  if (!entry || typeof entry.message !== 'string') return ''
  const subs = substitutions === undefined || substitutions === null
    ? []
    : (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String)
  const placeholders = {}
  for (const [placeholder, value] of Object.entries(entry.placeholders ?? {})) {
    placeholders[placeholder.toLowerCase()] = value?.content ?? ''
  }
  const named = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (match, placeholder) =>
    placeholder.toLowerCase() in placeholders ? placeholders[placeholder.toLowerCase()] : match
  )
  return named.replace(/\$(\$|[1-9])/g, (match, which) => (which === '$' ? '$' : (subs[Number(which) - 1] ?? '')))
}
