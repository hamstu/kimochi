---
name: Kimochi
description: A quiet instrument panel of small floating windows for reading games in Japanese.
colors:
  indigo-accent: "#3e63dd"
  indigo-accent-hover: "#3358d4"
  indigo-accent-text: "#3a5bc7"
  indigo-accent-text-dark: "#9eb1ff"
  indigo-accent-soft: "#0047f112"
  indigo-focus: "#8da4ef"
  indigo-focus-dark: "#435db1"
  accent-contrast: "#ffffff"
  window-ground: "#ffffff"
  window-ground-dark: "#111113"
  bar-plane: "#f9f9fb"
  bar-plane-dark: "#18191b"
  raised-plane: "#ffffff"
  raised-plane-dark: "#18191b"
  sunken-well: "#00005506"
  field-ground: "rgba(255, 255, 255, 0.85)"
  ink: "#1c2024"
  ink-dark: "#edeef0"
  ink-secondary: "#60646c"
  ink-secondary-dark: "#b0b4ba"
  ink-faint: "#80838d"
  ink-faint-dark: "#777b84"
  hairline: "#00002d17"
  hairline-dark: "#d3edf81d"
  control-line: "#00002f26"
  hover-wash: "#0000330f"
  press-wash: "#00002d17"
  danger: "#e5484d"
  danger-text: "#ce2c31"
  ok: "#30a46c"
  ok-text: "#218358"
  warn-text: "#ab6400"
  danger-soft: "#f3000d14"
  track: "#0009321f"
typography:
  heading-xl:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 620
    lineHeight: "1.625rem"
  title:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 620
    lineHeight: "1.375rem"
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 430
    lineHeight: "1.25rem"
  label:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 520
    lineHeight: "1.25rem"
  description:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 430
    lineHeight: "1.125rem"
  meta:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 520
    lineHeight: "1rem"
    fontFeature: "tnum"
  japanese:
    fontFamily: "Hiragino Sans, Hiragino Kaku Gothic ProN, Noto Sans JP Variable, Noto Sans JP, Yu Gothic UI, Meiryo, sans-serif"
  mono:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, JetBrains Mono, Menlo, monospace"
    fontSize: "0.95em"
rounded:
  sm: "0.25rem"
  md: "0.375rem"
  lg: "0.5rem"
  xl: "0.75rem"
  pill: "999px"
spacing:
  "0-5": "0.125rem"
  "1": "0.25rem"
  "1-5": "0.375rem"
  "2": "0.5rem"
  "2-5": "0.625rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
  bar-h: "1.75rem"
  row-h: "2rem"
  control-h: "1.75rem"
  control-h-sm: "1.5rem"
components:
  row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "0.375rem 0.75rem"
    height: "{spacing.row-h}"
    width: "100%"
  row-hover:
    backgroundColor: "{colors.press-wash}"
  row-selected:
    backgroundColor: "{colors.press-wash}"
  bar:
    backgroundColor: "{colors.bar-plane}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.meta}"
    padding: "0 0.375rem"
    height: "{spacing.bar-h}"
  button-secondary:
    backgroundColor: "{colors.field-ground}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 0.625rem"
    height: "{spacing.control-h}"
  button-primary:
    backgroundColor: "{colors.indigo-accent}"
    textColor: "{colors.accent-contrast}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 0.625rem"
    height: "{spacing.control-h}"
  button-primary-hover:
    backgroundColor: "{colors.indigo-accent-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    height: "{spacing.control-h}"
  button-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.ink}"
  button-ghost-active:
    backgroundColor: "{colors.indigo-accent-soft}"
    textColor: "{colors.indigo-accent-text}"
  button-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.md}"
    height: "{spacing.control-h}"
  button-danger-hover:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
  field:
    backgroundColor: "{colors.field-ground}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 0.5rem"
    height: "{spacing.control-h}"
  select-trigger:
    backgroundColor: "{colors.field-ground}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 0.375rem 0 0.5rem"
    height: "{spacing.control-h}"
  menu:
    backgroundColor: "{colors.raised-plane}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0.25rem"
  menu-item:
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 0.5rem"
    height: "1.75rem"
  menu-item-highlighted:
    backgroundColor: "{colors.press-wash}"
  settings-group:
    backgroundColor: "{colors.sunken-well}"
    rounded: "{rounded.lg}"
  settings-row:
    padding: "0.5rem 0.75rem"
    height: "2.75rem"
  switch:
    backgroundColor: "{colors.track}"
    rounded: "{rounded.pill}"
    width: "1.875rem"
    height: "1.125rem"
  switch-checked:
    backgroundColor: "{colors.indigo-accent}"
  badge:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.meta}"
    rounded: "{rounded.sm}"
    padding: "0 0.375rem"
    height: "1.125rem"
  dialog:
    backgroundColor: "{colors.raised-plane}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    width: "min(28rem, calc(100vw - 2rem))"
---

# Design System: Kimochi

## Overview

**Creative North Star: "The Quiet Instrument Panel"**

Kimochi is a set of small windows that float beside a game while the learner reads. Every window is built from one element: the Controller remote's row, full-bleed and aligned, 32px tall (2rem), highlighted by a neutral wash instead of colour. Title bars, tool bars and footers are one 28px strip (1.75rem) on a quieter bar plane. Menus, popovers and dialogs sit one plane up with a soft offset shadow. Nothing else adds depth.

The system is dense on purpose. The default UI text is 13px (0.8125rem), controls are 28px, and a hairline marks every separation. The palette is Radix slate neutrals with a single Radix indigo accent. Indigo means one of these things only: on, checked, current, focus, the single primary action on a surface, or a notebook-match word in the transcript. Japanese text is the only thing allowed to be large. The chrome recedes so the transcript and dictionary can carry the window.

The build rejects the web-app card grid. There are no floating cards, glows or nested panels. Settings sections are hairline-bordered groups of rows, and nothing is boxed inside a group.

**Key Characteristics:**
- One row grammar everywhere: full-bleed 2rem rows with a 1rem icon, a medium-weight label and faint tabular meta on the right.
- Three planes (window ground, bar plane, raised plane) plus a sunken well for previews, empty states and settings groups.
- Neutral hover and selection. Accent only for state, focus, primary action and notebook matches.
- Everything is sized in rem, so the Interface size setting scales type, spacing and controls together.
- Light, dark and system appearance. Both themes resolve from the same role tokens.
- App-drawn, platform-neutral chrome with a bundled UI face (Figtree).

## Colors

A cool slate neutral field with one indigo accent. Colour signals state; it never decorates.

### Primary
- **Kimochi Indigo** (`indigo-accent`, Radix indigo-9): the fill for switches, checked checkboxes, slider ranges and the one primary button. It turns `indigo-accent-hover` (indigo-10) on hover. Text on it uses `accent-contrast`.
- **Indigo Ink** (`indigo-accent-text` / `-dark`, indigo-11): accent used as text or icons. It marks notebook-match words in the transcript, the icon in a selected or current row, checkmarks in menus, links and active ghost buttons.
- **Indigo Wash** (`indigo-accent-soft`, indigo-a3): the soft accent ground behind active ghost buttons, accent badges and callouts, selected choice cards, and dictionary tokens or notebook chips on hover.
- **Focus Indigo** (`indigo-focus` / `-dark`, indigo-8): the 2px focus outline on every control. Fields also get a 2px indigo-a4 halo.

### Neutral
- **Window Ground** (`window-ground` / `-dark`): the base of every window. It is white in light mode and slate-1 in dark, and the same value is pushed to the native window background so windows never flash.
- **Bar Plane** (`bar-plane` / `-dark`, slate-2): title bars, tool bars, footers, the settings rail and dialog footers.
- **Raised Plane** (`raised-plane` / `-dark`): menus, popovers, dialogs and sheets. In dark mode it drops to slate-2 and is lifted by a shadow plus a gray-a6 inner line.
- **Sunken Well** (`sunken-well`, slate-a2): previews, empty states, code, kbd keys and the settings group ground.
- **Field Ground** (`field-ground`): inputs, select triggers and secondary buttons. In dark mode these use gray-a2 or gray-a3 with a gray-a5 inner line.
- **Ink** (`ink` / `-dark`, slate-12): primary text.
- **Secondary Ink** (`ink-secondary` / `-dark`, slate-11): descriptions, secondary labels, row icons and bar text.
- **Faint Ink** (`ink-faint` / `-dark`, slate-10): meta, placeholders, window-action icons and footer stats. Use it only for large or non-essential text.
- **Hairline** (`hairline` / `-dark`, gray-a4): every divider, bar edge, settings row separator and group border.
- **Control Line** (`control-line`, gray-a6): the inset 1px border on fields, secondary buttons and checkboxes.
- **Track** (`track`, gray-a5): the switch and slider track, and the active-press ground on rows.
- **Hover Wash / Press Wash** (`hover-wash` gray-a3, `press-wash` gray-a4): neutral state grounds. Rows and menu items use the press wash on hover. Ghost buttons use the hover wash.

### Status
- **Danger** (`danger`, `danger-text`, `danger-soft` red-a3), **OK** (`ok`, `ok-text`, green-a3 soft) and **Warn** (`warn-text`, amber-a3 soft) are used only for badges, dots, callouts, destructive buttons and destructive rows.

### Named Rules
**The One Voice Rule.** Indigo appears only for on, checked, current, focus, the single primary action per surface, and notebook-match words. A neutral item never gets an accent hover.

**The Role-Not-Value Rule.** Component code uses `--k-*` roles, never hex values or `prefers-color-scheme` queries. The appearance controller puts `.light` or `.dark` on `<html>`, and the roles resolve from there.

## Typography

**UI Font:** Figtree Variable (bundled, falling back to system-ui)
**Japanese Font:** Hiragino Sans, falling back to Noto Sans JP Variable (bundled), Yu Gothic UI and Meiryo
**Mono Font:** ui-monospace stack, for code, URLs, keys and file paths only

**Character:** Figtree is a warm, slightly geometric sans that reads small and stays neutral next to Japanese. The variable weights are tuned off-grid (430 / 520 / 620) so 13px text is solid without looking heavy.

### Hierarchy
- **Display** (620, 1.75rem / 28px, -0.02em): the "Kimochi" wordmark on the onboarding intro, and nowhere else.
- **Heading XL** (620, 1.125rem / 18px, 1.625rem): first-run and empty-state headings only.
- **Title** (620, 0.9375rem / 15px, 1.375rem, -0.005em, balanced wrap): settings page titles and dialog titles.
- **Heading** (620, 0.8125rem / 13px): settings section headings and empty-state titles.
- **Label** (520, 13px, 1.25rem): row labels, setting labels, button text.
- **Body** (430, 13px, 1.25rem): the default UI text, including fields, selects and menu items.
- **Description** (430, 0.75rem / 12px, 1.125rem, secondary ink, pretty wrap): setting descriptions, menus in bars, small buttons and tooltips.
- **Meta** (520, 0.6875rem / 11px, 1rem): title-bar text, bar content, badges, menu group labels and footer stats.

### Japanese text
Transcript lines use the Japanese stack at their own pixel size, the Log's `fontSizePx` setting (12 to 48px, stepped by the footer's A-down and A-up buttons). **The interface scale does not change transcript text.** Line geometry around it is in em, so padding follows the text. The dictionary popup headword is 1.5rem, a Japanese display size above the UI ramp that still follows the UI scale.

### Named Rules
**The Tabular Data Rule.** Counts, times, rates and shortcuts use tabular numerals (`k-num`, `tnum`) in the UI face. Mono is never decorative.

**The Five-Step Ramp Rule.** UI text uses 11, 12, 13, 15 or 18 and nothing in between. Only Japanese content and the onboarding wordmark leave the ramp.

## Layout

Every size is rem on a 4px grid (0.125rem to 2rem). The appearance controller sets the root font size to 16px × the interface scale (`interfaceScale`: small 0.92, medium 1 (default), large 1.1, extra large 1.22). Type, spacing, control heights, scrollbars and icons all scale together, and Radix `--scaling` follows the same factor.

- **Fixed heights:** bars 1.75rem, rows 2rem, menu items 1.75rem, controls 1.75rem (1.5rem small), settings rows at least 2.75rem.
- **Window structure:** an app-drawn 28px title bar (a drag region, a meta-size medium title and 1.75rem-wide window actions), then content, then an optional 28px footer bar. Controls inside bars shrink to the bar height minus 0.375rem.
- **Settings:** an 11rem flush left rail of rows on the bar plane with a hairline on its right, then a scrolling page up to 40rem wide (padding 1.25rem / 1.5rem / 2rem, 1.5rem between sections). In each setting row the label and description sit on the left and the control sits on the right, capped at 55% width. Rows stack when the control needs the full width.
- **Rows are full-bleed:** no side gutters around the list. Row lists have 0.25rem of vertical padding, and inset separators sit 0.75rem in from each side.
- **Chrome text is not selectable.** Inputs, content-editable text and `.k-selectable` surfaces opt in.

## Elevation & Depth

Depth comes from planes first, with shadow reserved for the raised plane. The window ground and bar plane are flat and separated by hairlines. Wells are sunken with an alpha tint. Only floating layers (menus, selects, popovers, dialogs, sheets) cast a shadow, which is always paired with a 1px inner line (gray-a5 in light mode, gray-a6 in dark).

### Shadow Vocabulary
- **Pop** (`--k-shadow-pop`): menus, selects, popovers and the notebook overlays. It is a soft two-layer offset shadow and is stronger in dark mode.
- **Dialog** (`--k-shadow-dialog`): dialogs and sheets, over a 36% (light) or 50% (dark) scrim.
- **Popup-window pop** (`--popover-shadow`): the same two-layer pop tightened to fit inside the 16px pad of the dictionary popup window, so the window edge never clips it.
- **Control lift** (`0 1px 1px rgb(0 0 0 / 0.04)`): a near-invisible lift under secondary buttons and select triggers in light mode only.
- **Thumb and segment lift**: small 1–3px shadows on switch and slider thumbs and on the "on" segment of a segmented control.

### Named Rules
**The Three Planes Rule.** Every surface is one of four things: ground, bar, raised or sunken well. A new surface picks one of those and never invents a fifth.

**The Paired-Line Rule.** Every raised surface carries its shadow together with an inset hairline, so it holds its edge in dark mode.

## Shapes

Borders are drawn as inset 1px box-shadows (`inset 0 0 0 1px`), not CSS borders, so they never change layout. The only real borders are the hairline edges of bars, the rail and the dialog footer. Radii are small and graded by size: sm 0.25rem (badges, kbd, checkboxes, transcript tokens), md 0.375rem (buttons, fields, selects, menu items, tooltips), lg 0.5rem (menus, popovers, settings groups, callouts, choice cards) and xl 0.75rem (dialogs). Rows are square (0) because they run edge to edge. Switches, sliders, dots and scrollbar thumbs are pills. Icons are lucide line icons at 16px in rows, 14px in buttons and menus, and 12px in bars and small buttons.

## Components

### Rows (signature)
The remote's grammar is the whole system in one element.
- **Shape:** full-bleed and square, at least 2rem tall, with padding of 0.375rem × 0.75rem and a 0.5rem gap.
- **Content:** a 1rem secondary-ink icon, a medium-weight label that truncates, and faint 12px tabular meta on the right.
- **Hover / highlighted:** press wash. **Active press:** gray-a5. **Selected / current:** press wash, with the icon turning indigo ink.
- **Danger rows:** hover to red-a4 with red-11 text and icon.
- **Focus:** a 2px focus-indigo outline inset by -2px. Disabled rows drop to 40% opacity and do not hover.

### Bars
- **Style:** 28px strips on the bar plane with a hairline on the inner edge, secondary ink at meta size, and 0.375rem side padding. They hold ghost buttons and ghost select triggers, which show no box until hovered.

### Buttons
- **Shape:** gently rounded (0.375rem), 1.75rem tall, 0.625rem side padding, medium-weight 13px text, 14px icons.
- **Secondary (default):** field ground with a control-line inset border. Hover is gray-3 in light mode and gray-a4 in dark.
- **Primary:** an indigo fill with contrast text that hovers to indigo-10. Use at most one per surface.
- **Ghost:** secondary ink with no box. Hover shows the hover wash and ink text. When pressed or active it uses the indigo wash with indigo ink.
- **Danger:** danger-soft ground with danger text. Hover fills solid red with white text.
- **All:** press scales to 0.97. Focus is a 2px indigo outline offset 1px. Disabled is 45% opacity. Small buttons are 1.5rem tall with 12px text and 12px icons, and icon buttons are square.

### Inputs / Fields
- **Style:** field ground, a control-line inset border and md radius, 1.75rem tall (textarea at least 4.5rem). A `mono` variant is available for URLs and keys.
- **Hover:** the border darkens to gray-a8.
- **Focus:** a 1px focus-indigo inset border plus a 2px indigo-a4 halo.
- **Error:** a 1px danger inset border. **Disabled:** 50% opacity.

### Select, Menus, Popovers, Tooltips
- **Select trigger:** the same box as a secondary button, with regular-weight text and a 12px faint chevron. Placeholder text is faint ink.
- **Menu:** raised plane, lg radius, 0.25rem padding, pop shadow with an inset line, at least 10rem wide. It opens with a 160ms scale-from-0.97 pop.
- **Menu item:** inset, md radius, 1.75rem tall. Highlight is the press wash, never indigo. Checked items are medium weight with an indigo check at the end. Group labels are faint meta text. Separators bleed to the menu edge.
- **Tooltip:** inverted (gray-12 ground, gray-1 text), 12px text, md radius, opening after a 500ms delay.

### Settings groups
- **Structure:** a page header (title and description), then sections. Each section has a 13px semibold heading, an optional description, and one group.
- **Group:** sunken-well ground, lg radius and a hairline inset border. Rows are separated by hairlines. Dependent rows are indented 1.25rem under their parent on the same ground with fainter gray-a3 separators, never boxed.
- **Row:** a medium label and a 12px secondary description on the left, the control on the right. Select triggers in rows are at least 9rem wide.

### Controls
- **Switch:** a 1.875 × 1.125rem pill in gray-a5 that turns indigo when on. The white thumb slides over 160ms with the out-expo curve. Use it for every on/off setting.
- **Checkbox:** 1rem, sm radius, indigo when checked. Use it only for multi-select lists.
- **Segmented:** a gray-a3 track with a 0.125rem inset, for 2–4 short exclusive options. The "on" segment is raised with a small lift in light mode and gray-a5 in dark.
- **Choice card:** for exclusive modes that each need a detail line (input source, engine). It uses field ground with a control-line border and lg radius. When selected it shows the indigo wash with a 1.5px indigo inset ring.
- **Slider:** a 0.25rem gray-a5 track, an indigo range and a 0.875rem white thumb.
- **Badge / dot / callout:** tone-tinted soft grounds (neutral, accent, ok, warn, danger). Callouts use the tint alone, with no border.

### Onboarding
The welcome guide is an ordinary panel window: the shared title bar, the window ground, and a footer action bar on the bar plane (like a dialog footer: hairline above, 0.75rem × 1rem padding) holding Back and the step dots on the left and the step's actions on the right, primary last. Each step is one column up to 40rem wide (prose up to 34rem): an 18px heading, a 13px secondary lede, then the step's controls, with no cards around them. The step dots are 6px gray-a6 dots, past steps faint ink, the current one a 16px indigo pill. The intro is the one decorated screen: the icon (`frontend/welcome/KimochiLogo.tsx`, built from `branding/icon.svg`) builds itself, then the display wordmark and tagline fade up; reduced motion shows the finished state.

### Gaming Mode
The controller surfaces drawn over a game (the radial menu, read-along's word outline and hint bar, the free cursor, the controls sheet and Recent text) use the same roles at about 1.3× for TV and handheld distance: type steps 14 / 16 / 17 / 20 / 24px, rows 44px, radii 5 / 8 / 10 / 16px, in the "Halo" design. The ring is a hub that names the chosen action, spokes fading out to large icons on rounded-square tiles, and a frosted halo fading out past the hub. Panels and the hint bar are frosted raised planes with inset rounded rows; the current row is the raised plane with a 2px indigo ring. The overlay has no Radix, so `ui/controller-variants.css` restates the roles as `--cm-*` tokens for any root marked `data-cm-variant="halo"`, with `data-cm-theme="light"|"dark"` set from the Appearance setting.

### Transcript (Log)
Japanese lines sit on the window ground at their own px size, separated by hairlines. Dictionary tokens get an indigo wash on hover. Notebook matches are indigo-ink words with a 1em round avatar or category marker. The footer shows stats in faint meta-size tabular numerals, separated by 0.1875rem gray-a7 dots.

## Do's and Don'ts

### Do:
- **Do** build lists of actions and navigation from full-bleed 2rem rows with a neutral press-wash highlight.
- **Do** keep every title bar, tool bar and footer at exactly 1.75rem on the bar plane, with a hairline on the inner edge.
- **Do** size everything in rem from `--k-*` tokens so the interface scale moves type, spacing and controls together. Leave transcript Japanese at its own `fontSizePx`.
- **Do** group each settings section's rows in one hairline-bordered sunken group, with the label on the left and the control on the right.
- **Do** put shadows only on the raised plane, always paired with an inset hairline, and check both light and dark.
- **Do** use tabular numerals in the UI face for counts, times and stats, and lucide icons at 16 / 14 / 12px.
- **Do** mirror hover rules to `[data-native-hover]` by keeping them in plain `:hover` stylesheet rules, so inactive windows still respond.

### Don't:
- **Don't** use indigo for hover on a neutral item, or for anything except on, checked, current, focus, the single primary action or notebook matches.
- **Don't** put more than one primary button on a surface.
- **Don't** use floating cards, glows or nested bordered boxes. Nothing nests inside a settings group.
- **Don't** hard-code hex colours, px sizes or ad-hoc shadows in component code, or branch on `prefers-color-scheme`.
- **Don't** add UI type sizes outside 11 / 12 / 13 / 15 / 18, or use mono for decoration.
- **Don't** use emoji or unicode glyphs as icons. Arrows inside `Kbd` keycaps are key labels, not icons.
- **Don't** depend on macOS-only fonts, vibrancy or native chrome. The chrome is app-drawn and platform-neutral.
