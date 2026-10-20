// Runs in Netflix's own page world (manifest.json: world MAIN, document_start), because only there can we
//  - see the playback manifest (it lists every subtitle track's download URL), and
//  - call Netflix's player API (setting video.currentTime directly makes the player throw an error).
// The extension's content script (src/netflix.js) talks to this file with window.postMessage:
//   content -> page  { subpair: true, dir: 'req', id, op, ... }      page -> content  { subpair: true, dir: 'res', id, ok, ... }
(() => {
  if (window.__subpairNetflix) return;
  window.__subpairNetflix = true;

  // Text formats, best first. Current Netflix builds list textTracks[].downloadables.<format>.urls[]; older ones list
  // timedtexttracks[].ttDownloadables.<format>. Image formats (nflx-cmisc, isImage) are never chosen.
  const FORMATS = ['imsc1.1', 'webvtt-lssdh-ios8', 'dfxp-ls-sdh'];
  // This file runs as a plain page script, outside the extension's modules, so its one tunable lives here.
  const MAX_MANIFESTS = 20;                                             // manifests kept (one per title the page has loaded)
  const manifests = new Map();                                          // movieId -> [{ lang, kind, forced, format, url, id }]

  function downloadUrl(d) {
    if (!d) return '';
    if (d.downloadUrls && typeof d.downloadUrls === 'object') {
      const u = Object.values(d.downloadUrls).find((x) => typeof x === 'string' && x);
      if (u) return u;
    }
    if (Array.isArray(d.urls)) {
      const u = d.urls.find((x) => x && x.url);
      if (u) return u.url;
    }
    return '';
  }

  function readTracks(list) {
    const out = [];
    for (const t of list) {
      const dl = t && (t.downloadables || t.ttDownloadables);
      if (!dl || t.isNoneTrack) continue;
      const format = FORMATS.find((f) => dl[f] && !dl[f].isImage && downloadUrl(dl[f]));
      if (!format) continue;                                           // image-based or unknown format
      out.push({
        lang: t.language || '', kind: String(t.rawTrackType || t.trackType || '').toLowerCase(), forced: !!t.isForcedNarrative,
        format, url: downloadUrl(dl[format]), id: t.id || t.new_track_id || t.trackId || '',
      });
    }
    return out;
  }

  // The episode order of a show, from the metadata the player loads for its episode list and "next episode" button:
  // { video: { seasons: [{ episodes: [{ episodeId | id }] }] } }. Each episode maps to the one after it, across seasons.
  const nextOf = new Map();
  function readEpisodes(r) {
    const video = r && r.video;
    if (!video || !Array.isArray(video.seasons)) return false;
    const ids = video.seasons.flatMap((s) => (Array.isArray(s && s.episodes) ? s.episodes : [])).map((e) => String((e && (e.episodeId || e.id)) || '')).filter(Boolean);
    for (let i = 0; i + 1 < ids.length; i++) nextOf.set(ids[i], ids[i + 1]);
    return ids.length > 0;
  }

  function inspect(r) {
    if (readEpisodes(r)) return;
    // The manifest sits at the top of the parsed object or one or two levels down, depending on the Netflix build.
    for (const m of [r, r && r.result, r && r.result && r.result.result, r && r.value]) {
      const list = m && typeof m === 'object' && (Array.isArray(m.textTracks) ? m.textTracks : Array.isArray(m.timedtexttracks) ? m.timedtexttracks : null);
      if (!list) continue;
      const tracks = readTracks(list);
      const movieId = String(m.movieId || (r && r.movieId) || '');
      if (!movieId || !tracks.length) continue;
      manifests.delete(movieId);
      manifests.set(movieId, tracks);
      if (manifests.size > MAX_MANIFESTS) manifests.delete(manifests.keys().next().value);      // browse-page previews add up
      return;
    }
  }

  const look = (r) => { try { if (r && typeof r === 'object') inspect(r); } catch { /* never break Netflix */ } return r; };
  const origParse = JSON.parse;
  JSON.parse = function (...args) { return look(origParse.apply(this, args)); };
  // Response.json() parses without going through JSON.parse, so a manifest fetched that way is looked at here.
  const origJson = typeof Response === 'function' && Response.prototype.json;
  if (origJson) Response.prototype.json = function (...args) { return origJson.apply(this, args).then(look); };

  // Netflix's own player object. This path is an internal of the Netflix web app, not a documented API.
  function player() {
    let vp;
    try { vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer; } catch { /* handled below */ }
    if (!vp) throw new Error('the Netflix player is not available on this page');
    const ids = vp.getAllPlayerSessionIds();
    return vp.getVideoPlayerBySessionId(ids[ids.length - 1]);
  }

  // Only these names can be asked for: a lookup that also found inherited names ("constructor", "valueOf") would run them.
  const ops = Object.assign(Object.create(null), {
    manifest: ({ movieId }) => ({ tracks: manifests.get(String(movieId)) || null }),
    next: ({ movieId }) => ({ next: nextOf.get(String(movieId)) || null }),
    async fetch({ url }) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { text: await r.text() };
    },
    seek: ({ ms }) => { player().seek(Math.max(0, Math.round(ms))); return {}; },
  });

  // The answer's envelope is written last, so no result can overwrite the id or direction the caller is waiting for.
  const reply = (id, body) => window.postMessage({ ...body, subpair: true, dir: 'res', id }, location.origin);

  window.addEventListener('message', async (e) => {
    const m = e.data;
    // e.source is not reliable between a Firefox content script and the page, so check the origin instead.
    if (e.origin !== location.origin || !m || m.subpair !== true || m.dir !== 'req') return;
    try {
      if (!Object.hasOwn(ops, m.op)) throw new Error(`unknown operation ${String(m.op).slice(0, 40)}`);
      reply(m.id, { ...(await ops[m.op](m)), ok: true });
    } catch (err) {
      reply(m.id, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
})();
