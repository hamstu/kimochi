---
version: 1
slug: "frontend-panel-html"
primary_target: "frontend/panel.html"
related_targets: ["frontend/source-picker.html","frontend/reader-popup.html","frontend/tray-popover.html","frontend/welcome.html"]
---

# Kimochi app windows

Scope: every React window (Controller, Log, Settings incl. new General tab, Notebook, Source picker, Tray popover, Reader/dictionary popups, Welcome). Mode: Operate.
Audience/job: a Japanese learner reading a game; windows float beside the game, often unfocused.
Constraints: compact and dense; Japanese text is the hero; Radix primitives; light/dark/system (system default); UI scale (medium default) moves type and spacing together; cross-platform later, so bundle the UI face and keep the chrome platform-neutral. Yomitan internals are only styled via supported custom CSS.
Direction: brief-pinned. The user named the Controller remote as the reference, so no concept roll was run; the remote's grammar becomes the system.

## Direction contract

THESIS: One quiet instrument panel. Every window is built from the remote's row: full-bleed, aligned, 32px, neutral highlight. It refuses the web-app card grid: no floating cards, glows or nested panels.

OWN-WORLD: Radix slate neutrals with one indigo accent used only for on/checked/current/focus, the single primary action per surface, and notebook-match words in the transcript. Hairline dividers (gray-a4/a5). Three planes: window ground, a quieter bar plane for title/tool/footer strips (all 28px), and an elevated plane for menus/popovers with an offset soft shadow. Bundled Figtree UI face at 11/12/13/15/18, weights 400/500/600, tabular numerals for data. Japanese in Hiragino/Noto Sans JP.

STORY: The learner reads without noticing chrome, finds any setting in seconds, and trusts that a row, menu, switch or select behaves the same in every window.

FIRST VIEWPORT: Settings: a flush left rail of remote-style rows under the 28px title bar, split by a hairline; on the right, a 15px page title, then grouped setting rows (label + description on the left, control on the right) with hairlines between them. On settings pages each section's rows sit in one hairline-bordered group so long pages scan by section; nothing nests inside a group (no boxed callouts or cards within it). Log: a 28px session bar (select + notebook), the Japanese transcript, and a 28px footer with stats in the UI face.

FORM: brief-pinned, extending the Controller remote; no concept-seed roll (a user-pinned direction beats the roll).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
