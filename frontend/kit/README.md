# Kimochi kit

The shared design system for every Kimochi window. Import components from `@kit`; import
`frontend/kit/kit.css` once per window entry (after `@radix-ui/themes/styles.css`).

## Rules

- **One source of values.** Type, spacing, sizes, radius, colour roles, depth and motion come from
  `tokens.css` (`--k-*`). No raw px sizes, hex colours or ad-hoc shadows in component code. The
  sizes are rem, so the Interface size setting scales everything; the transcript's Japanese text
  keeps its own px size (`fontSizePx`).
- **Type scale:** xs 11 (bars, badges, meta) · sm 12 (descriptions, menus, secondary) · md 13
  (default UI) · lg 15 (page and dialog titles) · xl 18 (first-run and empty headings). Weights:
  regular / medium / semibold. Use `k-num` (tabular numerals) for counts, times and stats. Mono is
  only for code, URLs, keys and file paths, never for decoration.
- **Planes:** window ground `--k-bg`; bars, rails and footers `--k-bar` (always `--k-bar-h`, 32px, the height of a row);
  wells `--k-sunken`; menus, popovers and dialogs `--k-raised` with `--k-shadow-pop`/`-dialog`.
- **States:** hover `--k-hover` (rows and menu items use `--k-press`), selected `--k-selected`.
  Accent (`--k-accent*`) only means on / checked / current / primary / focus. Never an accent
  hover on a neutral item.
- **Rows:** lists of actions or navigation use the full-bleed `Row` (the Controller remote's
  grammar). Menus and selects use inset `k-menu-item`s with a neutral highlight.
- **No cards for structure.** Group settings with `SettingsSection` (a hairline-bordered group of
  `SettingsRow`s), not floating cards. Never nest bordered boxes.
- **Icons:** lucide only, `--k-icon` (16) in rows, `--k-icon-sm` (14) in buttons and menus,
  `--k-icon-xs` (12) in bars and small buttons. No emoji or unicode glyphs as icons.
- **Theme:** light and dark both have to work. Use roles, never `prefers-color-scheme` media
  queries; the appearance controller puts `.light` / `.dark` on `<html>`.
- **Sound:** every button, link, switch, checkbox, tab and menu item clicks on its own (one listener per
  window, `ui/sounds.ts`), all with the same click. Give a control `data-sound="<name>"` when its
  job has its own sound (only the sidebar's whoosh does), or `data-sound="none"` when it already
  makes one (Scan).
- **Inactive windows:** `:hover` rules are mirrored to `[data-native-hover]` automatically; keep
  hover styles in plain `:hover` rules in stylesheets (not only in inline JS state).

## Components

| Component | Use |
| --- | --- |
| `Button` (`secondary` default, `primary`, `ghost`, `danger`; `size="sm"`; `icon`) / `IconButton label=…` | Actions. One primary per surface at most. |
| `Row`, `RowList`, `Separator inset` | Full-bleed action/navigation lists. |
| `Bar position="top" \| "bottom"`, `BarSpacer` | 28px tool bars and footers. |
| `Switch`, `Checkbox` | On/off settings use `Switch`; `Checkbox` only for multi-select lists. |
| `Input`, `Textarea` (`mono` for URLs/keys) | Text entry. Safe for Japanese IME input: a controlled value that comes back late through an async save never resets the text being composed. Key handlers on fields skip keys that belong to a composition with `isComposing(event)`. |
| `Select` (options list) or `SelectRoot`/`SelectTrigger`/`SelectContent`/`SelectItem` | Choosing one of many. `variant="ghost"` inside bars. |
| `Menu`, `MenuTrigger`, `MenuContent`, `MenuItem`, `MenuRadioItem`, `MenuSeparator`, `MenuLabel` | Action menus (line actions, session menu). |
| `Popover`, `PopoverContent` (`menu` prop for menu styling) | Anchored panels. |
| `Tooltip` | Hover explanations; wrap one focusable child. |
| `Dialog` + `DialogContent title description footer size variant="sheet"` | Modal work. `ConfirmDialog` for destructive confirmation (`dismissOnOutsideClick` when a click outside may cancel, as Escape does). |
| `Segmented` | 2–4 short exclusive options (theme, size). |
| `ChoiceGroup` | Exclusive modes that each need a detail line (input source, engine). |
| `Slider` | Continuous values. |
| `Badge tone`, `StatusDot tone`, `Callout tone`, `EmptyState`, `Spinner`, `Kbd` | Feedback and status. |
| `SettingsPage`, `SettingsSection`, `SettingsRow`, `SettingsSubgroup` | Every settings page. |
