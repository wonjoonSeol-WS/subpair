// The timings and counts that decide how the extension behaves over time: polling, retries, waits. (Sizes and spacing of
// the on-screen layout are named constants at the top of src/ui.js; the bridge's own settings are bridge/config.defaults.json.)
// Code takes these as defaults and lets a caller pass its own set, so tests do not wait on real timings.
export const TUNING = Object.freeze({
  translate: Object.freeze({
    contextLines: 6,                  // earlier cues sent with a live request for the model to read
    tickMs: 400,                      // how often the live loop looks at the playhead
    jumpSeconds: 2.5,                 // the playhead moved further than playback explains: it was a seek
    retryMs: 3000,                    // first wait after a failed request; doubles up to maxRetryMs
    maxRetryMs: 60000,
    notifyAfterErrors: 4,             // failures in a row before the user is told
    savedEnough: 0.95,                // a saved translation covering less than this share of the cues still needs live work
    jobPollMs: 2000,                  // whole-title job: how often progress is asked for
    lostAfterPolls: 5,                // ... and how many unanswered polls mean the bridge is gone
    saveWaitPolls: 60,                // saving the finished title: how many times to ask whether the job finished
    saveWaitPollMs: 1000,
  }),
  session: Object.freeze({
    pollMs: 1000,                     // how often the page is checked for a new video
    retryMs: 5000,                    // wait after a failed setup before trying again
    staleMs: 15000,                   // how long a transcoded (blob:) session may lag behind the player after an item change
    lookSaveMs: 500,                  // quick-menu look changes (size, position) are saved once the clicking stops
    toastMs: 1200,                    // how long a short notice stays on screen
  }),
  ahead: Object.freeze({
    readyPollMs: 20000,               // how often to check whether the next episode's subtitles can be read yet (Netflix: near the end)
    jobPollMs: 3000,                  // a season run: how often to ask whether the current title's job finished
  }),
  netflix: Object.freeze({
    manifestWaitMs: 25000,            // how long to wait for the playback manifest after the player starts
    manifestPollMs: 500,
    rpcMs: 15000,                     // one question to the page-world script
    fetchMs: 30000,                   // downloading a subtitle file through it
  }),
  bridge: Object.freeze({
    quickMs: 10000,                   // health, saved-translation lookups, job progress
    // A live translation waits on the bridge for up to its limits.lineWaitMs (20 s), then gets a ticket to poll. This must be
    // longer than that and shorter than the 30 s after which Chrome stops a worker whose fetch has no answer.
    lineMs: 25000,
  }),
});
