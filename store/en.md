# Subpair: store listing (English)

Copy these into the store forms. Korean: [ko.md](ko.md), Japanese: [ja.md](ja.md).
Upload files: `npm run package` writes `dist/packages/subpair-chrome-<version>.zip` and `dist/packages/subpair-firefox-<version>.zip`.

## Name
Subpair

## Summary (Chrome: 132 characters at most; AMO: 250)
Two subtitle lines at once on Netflix and Jellyfin, with a transcript, line replay, auto-pause and optional local translation.

## Description
Subpair shows two subtitle languages together, for learning a language while you watch: the line you are learning on top,
your own language under it.

- Works on Netflix and on your own Jellyfin server (the web player).
- Two lines at once: the main subtitle and a second one, each in the language you choose, with fallbacks.
- No track in your language? Subpair can translate the main line with a small program on your own computer (the bridge):
  ezTrans, Claude, the Anthropic API or any OpenAI-compatible service. Translations are saved per title and reused.
- Next episode translated ahead; on Jellyfin, a whole season with one click.
- Transcript panel, previous / repeat / next line, auto-pause at the end of every line.
- Click a word to copy it; Japanese words are colored by part of speech.
- On the video or in a bottom bar, text size, spacing, background: all in a quick menu in the player.
- Turn it off from the toolbar or with Alt+Shift+S to get the site's own subtitles back.
- English, Korean and Japanese interface.

Subpair has no account, no analytics and no server of its own. Subtitle text goes to the bridge on your own computer, and
from there only to the translator you choose. On Jellyfin, a finished translation is also saved to your own Jellyfin server
as a subtitle track (only when the title has none in that language), so its TV and phone apps can show it.

Step-by-step setup, including the translation bridge: https://wonjoonseol-ws.github.io/subpair/

Screenshots: Sintel (c) copyright Blender Foundation | durian.blender.org, CC BY 3.0.

## Category
Chrome: Education. Firefox: Language Support (also fits "Photos, Music & Videos").

## Single purpose (Chrome)
Shows two subtitle languages at the same time on video players (Netflix, Jellyfin) to help people learn a language.

## Permission justifications (Chrome)
- **storage**: saves the user's settings and profiles and the on/off switch.
- **scripting**: runs Subpair on a Jellyfin server only after the user granted access to that server (registers the content
  script for that one address, and starts it on the open page).
- **Host permissions http://127.0.0.1/\* and http://localhost/\***: to reach the optional translation bridge, a program the
  user runs on their own computer. No other host is contacted by the extension's worker.
- **Optional host permissions \*://\*/\***: Jellyfin is self-hosted at any address. Nothing is granted at install: access to
  one server is requested only when the user clicks the toolbar button on that server's page (or adds it in the options),
  and the browser asks the user first.
- **Content scripts on \*.netflix.com**: to read Netflix's subtitle tracks and draw the two lines on its player.
- **Web accessible resources**: the extension's own modules and the Japanese dictionary, loaded by its content script.
- **commands / action**: the toolbar button and keyboard shortcut that turn Subpair on and off.
- **Remote code**: none. All code ships in the package.

## Data use (Chrome "Privacy practices" / AMO data collection)
- Collected: **Website content** (subtitle text of the video being played), and only when a translation is needed.
- Where it goes: to the translation bridge at 127.0.0.1 on the user's own computer. The bridge is optional and run by the
  user; it may pass the text to the translation service the user configured (for example Anthropic or an OpenAI-compatible
  API) under the user's own account.
- On Jellyfin, a finished translation is also uploaded to the user's own Jellyfin server, the one the video plays from, as a
  subtitle track for that title (only when the title has no subtitle in that language). Nothing goes to the developer.
- Not collected: personal information, health, financial, authentication data (a Jellyfin login token is used only to call
  that same Jellyfin server and never sent anywhere else), location, browsing history, user activity.
- Certifications: data is not sold, not used or transferred for purposes unrelated to the single purpose, and not used to
  determine creditworthiness or for lending.
- Firefox manifest: `data_collection_permissions.required = ["websiteContent"]`.

## Privacy policy URL
https://wonjoonseol-ws.github.io/subpair/privacy.html

## Screenshots and promo tiles
Files in [screenshots/](screenshots/): 1280x800 24-bit PNG, Sintel (CC BY 3.0) playing on Jellyfin, menus in the listing's
language. Upload them in this order: on Chrome per language under Localised screenshots and the English set under Global
screenshots; on AMO the English set, with these captions.

1. `all-1-two-lines.png`: Two subtitle lines at once: the language you are learning on top, yours below. Japanese words
   are colored by part of speech.
2. `<lang>-2-gear-menu.png`: The gear menu on the player: choose the translator and when to translate, or translate a
   whole Jellyfin season.
3. `<lang>-3-auto-pause.png`: Auto-pause stops at the end of every line, and the transcript panel follows along. Here
   English with Japanese below.
4. `<lang>-4-click-word.png`: Click a word to copy it for your dictionary or flashcards. Here Korean with English below.
5. `<lang>-6-options.png`: Settings: languages with fallbacks, translator, layout and keys.

Chrome promo tiles: `promo-small-440x280.png` and `promo-marquee-1400x560.png`, rendered at exactly that size from
`tile-small.html` and `tile-marquee.html`.
