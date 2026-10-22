---
title: Troubleshooting
nav: Troubleshooting
order: 3
ref: troubleshooting
lang: en
language: English
lang_order: 1
---

# Troubleshooting

## Nothing appears

- **No languages chosen yet**: a notice *Subpair: choose your languages* appears at the top right. Open the settings
  and pick a main language.
- **Subpair is off**: the toolbar button shows *OFF*. Click it or press Alt+Shift+S.
- **Jellyfin server not enabled yet**: on the Jellyfin page, click the Subpair button in the browser toolbar once, or add
  the address under *Jellyfin servers* in the settings. A server allowed in an earlier version of Subpair needs this once
  more.
- **Netflix right after installing or updating**: reload the Netflix tab once.
- **The video has no text subtitles in your main language**: image subtitles (PGS, VobSub) cannot be read. Pick
  another main language, or add a text subtitle file to the Jellyfin item.

## The second line is missing or in another language

The second line uses the first of your second-line languages that has a track. When none has one, the main line is
translated, which needs the bridge. The gear menu's **Second subtitle** row says what is shown and why. Common causes:

- *translation bridge is not running*: double-click `start-bridge.cmd` in the Subpair folder, or have it start with
  Windows (see [Translation](translation.html)).
- *no translator is ready*: the bridge's `/health` page shows which translators are set up.
- The bridge address in the settings does not match the bridge's port.

## The subtitles are out of sync

Use the gear menu's **Subtitle timing** to move the whole main line or the whole second line earlier or later for this
video. If a subtitle file is off in
some parts only, the file itself needs fixing: a downloaded file can be timed for another release, or even be for another
episode. For Jellyfin libraries, subsync-repair (a separate project) checks and fixes subtitle files against the
video's own tracks. For a bad second-line track, **Translator**, **Translate from the main line instead** replaces
it with a translation.

## The bridge does not start

- `cannot listen on 127.0.0.1:8765`: another bridge already runs on that port. Stop it, or set another port with
  `BRIDGE_PORT` (and the same address in the settings).
- `unknown setting`: a name in `bridge/config.json` is misspelled; compare with `bridge/config.defaults.json`.
- Node.js older than 21: install a current version.

## Error messages from the bridge

The player shows the bridge's errors in your language. The ones that need you:

| Message | What to do |
|---|---|
| the claude command did not run | install Claude Code, run `claude` once to log in, or set `claude.command` |
| no Anthropic API key | set `ANTHROPIC_API_KEY` or `api.key`, then restart the bridge |
| OpenAI-compatible backend is not set up | set `openai.baseUrl`, `openai.model` and, for a hosted service, its key |
| ezTrans XP was not found | set `eztrans.dir` to the ezTrans XP folder (Windows only) |
| cannot run ... safely through cmd.exe | point `claude.command` at an `.exe`, not a `.cmd` |
| forbidden origin | `allowedOrigins` in `bridge/config.json` does not list this copy of Subpair: add its current ID (it changes when the extension is loaded from another folder), then restart the bridge |

## Where are the logs

- Bridge started by hand: in its terminal.
- Windows startup task: `%LOCALAPPDATA%\subpair\bridge.log`, or the file given with `-Log`.
- The extension: the browser's developer console of the Netflix or Jellyfin tab (lines start with `[Subpair]`).

## None of the above?

[Open an issue on GitHub](https://github.com/wonjoonSeol/subpair/issues). Say which browser and site (Netflix or
Jellyfin) you use, what you expected and what happened instead, and add the `[Subpair]` lines from the console or the
bridge log if you have them.
