// Content scripts cannot use static ES module imports, so load the real code as a module.
(async () => {
  try {
    const { start } = await import(chrome.runtime.getURL('src/main.js'));
    await start();
  } catch (e) {
    console.error('[Subpair] failed to start', e);
  }
})();
