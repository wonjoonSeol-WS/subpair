---
title: Privacy policy
nav: Privacy
order: 4
ref: privacy
lang: en
language: English
lang_order: 1
---

# Privacy policy

Last updated: 2026-10-20

Subpair is a browser extension that shows two subtitle lines on Netflix and on Jellyfin servers. It has no server of its
own: nothing is sent to the developers, and nothing is collected for analytics, advertising or any other purpose.

## What Subpair reads

- **Subtitle tracks** of the title you are playing: on Netflix, from the subtitle list that Netflix's player loads; on a
  Jellyfin server, from that server's subtitle tracks for the item.
- **On Jellyfin only**, what Jellyfin's web client keeps in the page's local storage: the sign-in token, the user ID, the
  server address and the device ID. Subpair uses them only to ask that same Jellyfin server which item is playing on this
  device, for that item's details and for its subtitle tracks.
- Subpair works on a Jellyfin server only after you allow that server.

## What Subpair stores, in your browser

- **Your settings and profiles** (languages, layout, shortcuts, translator choice), in the browser's extension sync
  storage. If you are signed in to your browser, the browser may sync them to your browser account. When they are too large
  for sync storage, they stay on this computer only.
- **On this computer only**: the on/off switch, the Jellyfin servers you allowed, whether the transcript panel shows in
  fullscreen, and the titles for which you chose "Translate from the main line instead".

Removing the extension removes the data stored on this computer. Settings that your browser synced to your browser account
are kept or removed by your browser's sync service, as it handles extension data.

## What Subpair sends, and to whom

- **Nothing**, unless a second line needs translating and you use the optional translation bridge.
- **Then:** the subtitle text of the title goes to the bridge at `127.0.0.1` / `localhost`, a separate program that you run
  on your own computer. Subpair talks to no other address for translation.
- **What the bridge does with it** depends on how you set it up:
  - **ezTrans:** translated on your computer.
  - **Claude (`claude -p`):** sent to Anthropic through your own Claude Code login.
  - **Anthropic API, or an OpenAI-compatible API:** sent to that provider with your own API key, or to a model server you
    run yourself.

  In those cases the provider receives the subtitle text under your own account and its own terms. The bridge saves
  finished translations on your computer.

## What Subpair never does

- No analytics, telemetry, crash reporting or advertising.
- No server operated by the developers; no data is sold, shared or transferred to the developers or anyone else.
- No remote code: everything Subpair runs is part of the extension package.

## Firefox data declaration

Firefox asks extensions to declare data they transmit. Subpair declares **website content** (`websiteContent`), because
subtitle text from the page can leave the extension for the local translation bridge.

## Contact

Questions or problems: open an issue in the project's repository.
