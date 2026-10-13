# Dictionary pop-up previews

Pictures of each dictionary engine's pop-up, shown in the dictionary chooser (Settings →
Dictionary, and onboarding's dictionary step) by `frontend/components/DictionaryPreview.tsx`.
Files are found at build time: a missing one is simply not shown.

## Files

`<engine>-<theme>.<format>`:

| Engine | Light | Dark |
| --- | --- | --- |
| Built-in Yomitan | `yomitan-light` | `yomitan-dark` |
| Hachidori | `hachidori-light` | `hachidori-dark` |
| 10ten | `tenten-light` | `tenten-dark` |
| Kimochi pop-up (Yomitan API) | `custom-api-light` | `custom-api-dark` |

- **Format:** `.webp` (what the capture writes), `.png`, `.jpg` or `.jpeg`. A PNG or JPEG wins over
  a WebP of the same name, so a screenshot dropped in by hand replaces the captured one without
  deleting it.
- **Theme:** the picture matching the window's theme shows. With only one of the two, that one
  shows in both themes.
- **Size:** 16:10, 1440 × 900 px (a 960 × 600 scene at 1.5×). Other sizes work but are shown at
  16:10; keep the pop-up and the word it looks up inside the frame. The thumbnail is at most
  22rem wide, the enlarged view up to the large dialog's width.
- **Weight:** at most 150 KB each (`scripts/dictionary-previews.test.mjs` checks it).

## Capturing

```sh
npm run capture:dictionary-previews
```

Runs every engine in headless Chrome over one line of game dialogue (`frontend/dev/dictionary-preview.html`),
points at 食べられなかった with Shift held, and writes all eight pictures here. Options:
`--engine yomitan,hachidori,tenten,custom-api`, `--theme light,dark`, `--dicts <dir>` (folder of
Yomitan dictionary zips, default `../yomitan-dicts` or `$KIMOCHI_YOMITAN_DICTS`), `--api <url>`
(Yomitan API, default `http://127.0.0.1:19633`), `--offline`, `--port <n>` (dev server, default
1470). What each engine needs:

- **Built-in Yomitan, Hachidori:** a JMdict Yomitan zip in `--dicts` (and the CC100 frequency list,
  if there). The capture cuts the few entries the lookup reaches into a temporary dictionary and
  imports it; nothing of it is kept.
- **10ten:** nothing; it ships its own dictionary and updates it from its server (needs a
  connection the first time).
- **Kimochi pop-up:** a running Yomitan API. Its answer is recorded to
  `scripts/fixtures/dictionary-previews/yomitan-api.json`, which `--offline` (or an unreachable
  API) replays.

Only JMdict and CC100 content appears: glossaries from other dictionaries in a Yomitan API answer
are left out.

## Attribution

The dictionary entries pictured are from JMdict, the property of the Electronic Dictionary
Research and Development Group, used in conformance with the Group's
[licence](https://www.edrdg.org/edrdg/licence.html) (CC BY-SA 4.0). Frequency ranks are from the
CC100 frequency list for Yomitan.
