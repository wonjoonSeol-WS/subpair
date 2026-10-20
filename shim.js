// Firefox: use its promise-based `browser` API under the name `chrome`, which all extension code uses.
// (Firefox's own `chrome` object is callback-based for some calls.) A no-op in Chrome, where `browser` does not exist.
if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) globalThis.chrome = browser;
