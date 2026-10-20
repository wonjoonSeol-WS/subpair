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
  device, for that item's details and for its subtitle tracks, and to add a finished translation to that item (below).
- Subpair works on a Jellyfin server only after you enable that server. Unless the server's address is localhost or
  127.0.0.1, your browser first asks you to give Subpair access to it. You can take that access back in the settings (*Jellyfin servers*) or in
  your browser's extension settings.

## What Subpair stores, in your browser

- **Your settings and profiles** (languages, layout, shortcuts, translator choice), in the browser's extension sync
  storage. If you are signed in to your browser, the browser may sync them to your browser account. When they are too large
  for sync storage, they stay on this computer only.
- **On this computer only**: the on/off switch, the Jellyfin servers you enabled, whether the transcript panel shows in
  fullscreen, the titles for which you chose "Translate from the main line instead", and which translations Subpair added
  to which Jellyfin items.

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
- **To your own Jellyfin server:** a finished translation of a Jellyfin title is added to that title, on the server it is
  on, as a subtitle track, so your other Jellyfin apps show it. This happens only when the title has no subtitle in that
  language. It goes to no other server.

## What Subpair never does

- No analytics, telemetry, crash reporting or advertising.
- No server operated by the developers; no data is sold, shared or transferred to the developers or anyone else.
- No remote code: everything Subpair runs is part of the extension package.

## Firefox data declaration

Firefox asks extensions to declare data they transmit. Subpair declares **website content** (`websiteContent`), because
subtitle text from the page can leave the extension for the local translation bridge.

## This website

This website (not the extension) counts visits with [GoatCounter](https://www.goatcounter.com/), an open-source
counter. It keeps only totals, such as how many visits a page had, not who made them, and it never stores IP addresses
or browser details ([how GoatCounter counts](https://www.goatcounter.com/help/sessions)).

## Contact

Questions or problems: open an issue in the project's repository.
