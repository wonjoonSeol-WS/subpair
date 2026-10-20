# Subpair

English | [한국어](README.ko.md) | [日本語](README.ja.md)

Subpair is a browser extension that shows **two subtitle lines at once** on **Netflix** and **Jellyfin**: the language
you are learning and your own. A transcript panel, line replay, auto-pause and click-to-copy words help you study while
you watch, in the style of Language Reactor. When a title has no subtitles in your language, an optional program on
your computer translates the main line.

![Japanese and Korean lines on a Jellyfin video, with the transcript panel](docs/images/jellyfin-player.png)

## Features

- Two lines at once, each with fallback languages; text stays selectable for dictionary extensions such as Yomitan.
- Previous / repeat / next line, auto-pause at the end of every line, a clickable transcript panel.
- Japanese words colored by part of speech; click a word to copy it or its dictionary form.
- Optional translation through a local **bridge**: ezTrans, Claude Code, the Anthropic API or any OpenAI-compatible API
  (OpenAI, Gemini, DeepSeek, Ollama...). Finished translations are saved and never paid for twice.
- English, Korean and Japanese interface, following your browser's language.

## Install

1. Download or clone this repository.
2. Chrome or Edge: open `chrome://extensions` (Edge: `edge://extensions`), switch on Developer mode, click
   **Load unpacked** and pick this folder.
   Firefox: run `npm run build:firefox` and load `dist/firefox/manifest.json` from `about:debugging`.
3. Choose your languages in the settings page that opens, then play something on Netflix or Jellyfin.

Translation is optional: install [Node.js](https://nodejs.org/) 21+, copy `bridge/config.example.json` to
`bridge/config.json`, and run `npm run bridge`.

**The full step-by-step guide is in [docs](docs/index.md)** (also published as the project's website): setup for
Netflix and Jellyfin, translators, models and costs, starting the bridge with your computer, and troubleshooting.

## Platforms

| | Windows | macOS | Linux |
|---|---|---|---|
| Extension (Chrome 111+, Edge, Brave, Firefox 128+) | yes | yes | yes |
| Bridge with Claude, the Anthropic API or an OpenAI-compatible API | yes | yes | yes |
| ezTrans translator | yes | no | no |

Only Windows is tested by the author. Firefox installs are temporary until a signed version is published.

## Privacy

Subpair reads subtitles from the page you are watching. Nothing leaves your computer unless you turn on translation:
then the subtitle lines go to the bridge on `127.0.0.1` and from there to the translator you chose. Subpair asks before
it works on a Jellyfin server.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. `vendor/kuromoji` is Apache-2.0. Subpair is not affiliated with Netflix or Jellyfin.
