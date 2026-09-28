/**
 * Makes `:hover` styling work in an INACTIVE native window.
 *
 * WebKit suppresses mouse events in inactive windows (https://bugs.webkit.org/show_bug.cgi?id=187545),
 * so `:hover` never matches while another app is focused — which is the normal case for Kimochi,
 * since the game keeps focus. `useNativeHover` marks the hovered element (and its ancestors, because
 * `:hover` matches ancestors too) with `data-native-hover` from a native pointer hit test.
 *
 * This module makes the existing styles respond to that attribute: it walks every same-origin
 * stylesheet and re-emits each `:hover` rule with `:hover` replaced by `[data-native-hover]` into
 * one appended <style>. That covers CSS Modules (hashed class names), Radix Themes and anything
 * added later, without editing a single original stylesheet. Specificity is identical ((0,1,0)
 * either way) and the mirror sheet comes last, so it wins.
 *
 * A rule is re-emitted from its `cssText`, not from `style.cssText`, because the app's own CSS
 * Modules put the declarations in nested at-rules — `RemoteControl.module.css` writes
 * `.button:hover { @media (prefers-color-scheme: dark) { … } }`, whose own `style.cssText` is
 * empty. Nested rules are also traversed so `&:hover` inside a parent rule is mirrored too.
 */
const MIRROR_ATTRIBUTE = 'data-native-hover'
const MIRROR_ID = 'native-hover-mirror'

function mirrorSelector(selectorText: string): string {
  // `:hover(` never occurs; a plain global replace is safe, including inside :not()/:is().
  return selectorText.replace(/:hover\b/g, `[${MIRROR_ATTRIBUTE}]`)
}

/** Resolves a nested selector against its parent, handling `&`. */
function resolveSelector(selectorText: string, parent: string | null): string {
  if (!parent) return selectorText
  return selectorText.includes('&')
    ? selectorText.replace(/&/g, parent)
    : `${parent} ${selectorText}`
}

/** Everything from the rule's opening brace onwards, i.e. its declarations AND nested rules. */
function ruleBody(rule: CSSRule): string | null {
  const text = rule.cssText
  const brace = text.indexOf('{')
  return brace === -1 ? null : text.slice(brace)
}

function collect(
  rules: CSSRuleList,
  conditions: string[],
  parentSelector: string | null,
  out: string[]
): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const resolved = resolveSelector(rule.selectorText, parentSelector)
      if (resolved.includes(':hover')) {
        const body = ruleBody(rule)
        if (!body) continue
        const mirrored = `${mirrorSelector(resolved)}${body}`
        out.push(conditions.reduceRight((inner, condition) => `${condition}{${inner}}`, mirrored))
        // The body already carries this rule's nested rules; recursing would emit them twice.
        continue
      }
      if (rule.cssRules?.length) collect(rule.cssRules, conditions, resolved, out)
      continue
    }
    const nested = (rule as CSSGroupingRule).cssRules
    if (!nested) continue
    let condition: string | null = null
    if (rule instanceof CSSMediaRule) condition = `@media ${rule.conditionText}`
    else if (rule instanceof CSSSupportsRule) condition = `@supports ${rule.conditionText}`
    else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule)
      condition = `@layer ${rule.name}`
    collect(nested, condition ? [...conditions, condition] : conditions, parentSelector, out)
  }
}

/** Rebuilds the mirror sheet from the stylesheets currently in the document. */
export function refreshHoverMirror(): void {
  const mirrored: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null
    try {
      rules = sheet.cssRules
    } catch {
      // A stylesheet we may not read (never expected here — every sheet is same-origin).
      continue
    }
    if (rules) collect(rules, [], null, mirrored)
  }

  let style = document.getElementById(MIRROR_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = MIRROR_ID
    document.head.append(style)
  } else if (style !== document.head.lastElementChild) {
    // Keep it last so it still wins after a late-injected stylesheet.
    document.head.append(style)
  }
  style.textContent = mirrored.join('\n')
}

/** Installs the mirror and keeps it in sync as stylesheets are added. Call once per window. */
export function installHoverMirror(): () => void {
  // Per-install, so a StrictMode remount (mount, unmount, mount) cannot leave a stale frame id
  // behind and skip the rebuild.
  let scheduled = 0

  const schedule = (): void => {
    if (scheduled) return
    scheduled = requestAnimationFrame(() => {
      scheduled = 0
      refreshHoverMirror()
    })
  }

  schedule()
  window.addEventListener('load', schedule)

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof HTMLStyleElement && node.id !== MIRROR_ID) return schedule()
        if (node instanceof HTMLLinkElement && node.rel === 'stylesheet') {
          node.addEventListener('load', schedule, { once: true })
          return schedule()
        }
      }
    }
  })
  observer.observe(document.head, { childList: true })

  return () => {
    observer.disconnect()
    window.removeEventListener('load', schedule)
    if (scheduled) {
      cancelAnimationFrame(scheduled)
      scheduled = 0
    }
    document.getElementById(MIRROR_ID)?.remove()
  }
}

export { MIRROR_ATTRIBUTE }
