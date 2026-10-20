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

Subpair has no account, no analytics and no server of its own. Subtitle text only goes to the bridge on your own computer,
and from there only to the translator you choose.

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
- Not collected: personal information, health, financial, authentication data (a Jellyfin login token is used only to call
  that same Jellyfin server and never sent anywhere else), location, browsing history, user activity.
- Certifications: data is not sold, not used or transferred for purposes unrelated to the single purpose, and not used to
  determine creditworthiness or for lending.
- Firefox manifest: `data_collection_permissions.required = ["websiteContent"]`.

## Privacy policy URL
https://wonjoonseol-ws.github.io/subpair/privacy.html

## Screenshots to take (1280x800)
1. Netflix or Jellyfin with both lines on the video.
2. The bottom bar with the transcript panel.
3. The quick menu (gear) open on Translator.
4. The options page.
