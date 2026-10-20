# Contributing to Subpair

Thanks for helping. Bug reports, translations of the interface and pull requests are all welcome.

## Reporting a problem

Open an issue with:

- the browser and its version, and whether it was Netflix or Jellyfin (with the Jellyfin version);
- what you expected and what happened;
- the `[Subpair]` lines from the developer console of the video tab, and, if translation is involved, the bridge's
  output and its `/health` answer. Remove API keys and personal paths first.

## Setting up

You need [Node.js](https://nodejs.org/) 21 or newer.

```
git clone <this repository>
cd subpair
npm install          # test-only tools: the kuromoji dictionary for the Japanese tests and web-ext
npm test             # every test in tests/*.test.mjs
npm run bridge       # the translation bridge on 127.0.0.1:8765
npm run build:firefox
```

Load the folder unpacked in Chrome (`chrome://extensions`, Developer mode) and reload the extension and the video tab
after a change. For Firefox, build and load `dist/firefox/manifest.json` from `about:debugging`.

## Where things are

| Path | What it does |
|---|---|
| `content.js`, `src/main.js` | finds the site and the video and runs one playback session |
| `src/jellyfin.js`, `src/netflix.js`, `src/netflix-page.js` | site adapters: tracks, video, layout selectors (the only code that knows each site's markup) |
| `src/session.js`, `src/tracks.js` | which two lines to show for the active profile |
| `src/translate.js`, `src/bridge.js`, `src/backends.js` | live and whole-title translation through the bridge |
| `src/ui*.js`, `src/quickmenu.js` | the lines, the panel, the gear menu |
| `src/profile.js`, `src/storage.js`, `options.*` | settings |
| `src/i18n.js`, `_locales/<lang>/messages.json` | interface text in English, Korean and Japanese |
| `src/ja.js`, `src/analyzer.js`, `vendor/kuromoji` | Japanese word splitting and coloring |
| `bridge/` | the local translation bridge (Node, no dependencies) |
| `scripts/` | the Firefox build and the Windows background runner |
| `docs/` | the guide, published with GitHub Pages |

## Rules for changes

- **Tests**: add or update a test for every behaviour change, and run `npm test` before you open a pull request. When
  code picks one value among several candidates, the test needs a case where the candidates differ.
- **Interface text**: never write user-visible text in code. Add a key to all three `_locales/*/messages.json` files
  and use `t('key')`; `tests/i18n.test.mjs` checks that every key exists and is used.
- **Languages**: never assume a particular language pair. Languages come from the user's profile.
- **Sites**: keep site-specific selectors and APIs in the adapters.
- **Bridge**: it must stay local (`127.0.0.1`), keep API keys out of logs and error messages, and validate every request.
- **Style**: plain modern JavaScript (ES modules), readable names, short functions. Comments only for what the code
  cannot say (an outside constraint, a browser quirk); no history in comments.
- **Docs**: if a change is visible to users, update `docs/` and the three READMEs (English, Korean, Japanese).

## Pull requests

Keep a pull request to one topic, describe what changed and how you tested it (browser, site, translator), and include
screenshots for visible changes.

## License

By contributing you agree that your contribution is licensed under the MIT License of this project.
