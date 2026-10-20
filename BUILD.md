# Building the packages

Needs Node.js 21 or newer and npm (made with Node 24.19.0 and npm 11.17.0 on Windows 11; nothing in the build depends
on the operating system).

```sh
npm ci
npm run package
```

Output:

- `dist/packages/subpair-firefox-<version>.zip`: the Firefox package (its files are in `dist/firefox/`).
- `dist/packages/subpair-chrome-<version>.zip`: the Chrome package (its files are in `dist/chrome/`).

`scripts/build-firefox.mjs` copies, unchanged, every file reachable from the browser's manifest (`manifest.firefox.json`
or `manifest.json`) plus `_locales/` and `LICENSE`, and `web-ext build` zips them. Nothing is transpiled, bundled or
minified.

## Third-party code

`vendor/kuromoji/` is kuromoji 0.1.2 (Apache-2.0), also installed by `npm ci` as a dev dependency:

- `vendor/kuromoji/kuromoji.js` is `node_modules/kuromoji/build/kuromoji.js` with the two changes listed in
  `vendor/kuromoji/NOTICE.md`. `diff node_modules/kuromoji/build/kuromoji.js vendor/kuromoji/kuromoji.js` shows them.
- `vendor/kuromoji/dict/` is identical to `node_modules/kuromoji/dict/`.
