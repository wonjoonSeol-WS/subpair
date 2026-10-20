---
title: Translation
nav: Translation
order: 2
ref: translation
lang: en
language: English
lang_order: 1
---

# Translate subtitles

No subtitles in your language? Subpair can translate the original ones and show them as the second line. A small program
on your computer, the **translation helper**, does the translating. Every title it translates is saved, so the next time
it shows up at once. On Jellyfin, once an episode is translated, the next one is translated ahead.

## Which translator?

| Translator | For you if | Cost |
|---|---|---|
| **ezTrans** | you watch Japanese shows in Korean on Windows (needs ezTrans XP) | free, works offline |
| **Claude** | you have a Claude subscription. Any language | included in your plan |
| **AI API** | you have an API key for Anthropic, OpenAI, Gemini or similar | about $0.01 per episode |
| **Local AI** | you use Ollama or LM Studio | free |

You don't have to choose. The default, **Automatic**, uses the first translator that is ready; for Japanese to Korean that
is ezTrans.

## Start with ezTrans (Windows)

1. **Install ezTrans XP**, if it isn't already. The helper finds its folder by itself.
2. **Install Node.js**: download the **LTS** version from [nodejs.org](https://nodejs.org/) and install it with the
   default options.
3. **Download Subpair**: [download the ZIP](https://github.com/wonjoonSeol-WS/subpair/archive/refs/heads/main.zip) and
   unzip it somewhere you like, such as your Documents folder.
4. **Start the helper**: in the unzipped folder, double-click `start-bridge.cmd`. When the black window shows
   `ezTrans XP in ...`, you are ready. Keep that window open while you watch.
5. **Play a show** that has only Japanese subtitles. The Korean translation appears as the second line.

Windows may warn you because the file came from the internet. Click **Run**. If a blue window appears instead, click
**More info** and then **Run anyway**.

### Start the helper with Windows

In the unzipped folder, open `scripts\windows` and double-click `autostart-on.cmd`. The helper then starts hidden every
time you sign in to Windows, and you no longer need `start-bridge.cmd`. To undo it, double-click `autostart-off.cmd` in the
same folder.

### If it doesn't work

- **The black window says `ezTrans XP not found`**: make sure ezTrans XP is installed in its default folder. If it is
  somewhere else, set its folder as described in the [README's bridge setup](https://github.com/wonjoonSeol-WS/subpair#bridge-setup).
- **It says `Node.js is not installed`**: install Node.js (step 2), then double-click the file again.
- **No translation appears**: check that the helper window is still open. Closing it stops translation.

## Other translators

Starting the helper is the same (steps 2 to 4 above). Set up the translator, then pick it under **Translator** in the
video's gear menu.

- **Claude**: install [Claude Code](https://claude.com/claude-code), start it once and sign in. That's all.
- **AI API, local AI**: an API key or an address goes into the helper's settings file. See the
  [README's bridge setup](https://github.com/wonjoonSeol-WS/subpair#bridge-setup).

The helper also runs on macOS and Linux (ezTrans is Windows only). How to start it there is in the README.

## Cost

With an AI API, one anime episode (about 300 lines) costs **about $0.01**, and a 12-episode season **about $0.07 to
$0.12**. This is an estimate at the prices of the default model, Claude Haiku 5.5. Lines already translated are never paid
for again. ezTrans and local AI are free, and Claude counts toward your subscription.

## In the gear menu

- **Translator**: which translator, and when to translate (Automatic, Live a few lines ahead, or the whole title now).
- **Translate this title again**: a fresh translation if you don't like the saved one (click twice).
- **Translate the whole season** (Jellyfin): translates the episodes one after another, ahead of time.
- **Translate from the main line instead**: when a show's own subtitles in your language are poor or out of sync, use a
  translation instead. Remembered per title.

On Jellyfin, a finished translation is also added to the episode as a subtitle, so the Jellyfin apps on your TV and phone
show it too. This happens only for episodes without a subtitle in that language, and your Jellyfin account needs
permission to manage subtitles.
