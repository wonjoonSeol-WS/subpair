// Content scripts cannot use static ES module imports, so load the real code as a module. The script can arrive twice on a
// Jellyfin page (registered for the server, and injected at once when the user allows it), so it starts only once.
(async () => {
  if (window.__subpairStarted) return;
  window.__subpairStarted = true;
  try {
    const { start } = await import(chrome.runtime.getURL('src/main.js'));
    await start();
  } catch (e) {
    console.error('[Subpair] failed to start', e);
  }
})();
