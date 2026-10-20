import test from 'node:test';
import assert from 'node:assert/strict';
import { toTrack as jellyfinTrack, textTracks, serverBase, adapter as jellyfin } from '../src/jellyfin.js';
import { toTrack as netflixTrack, movieIdFromPath, joinedText, adapter as netflix } from '../src/netflix.js';
import { pickTrack } from '../src/tracks.js';

test('Jellyfin streams become common tracks: format and default flag raise the rank, sign/song titles are extra', () => {
  const srt = jellyfinTrack({ Index: 3, Language: 'jpn', Codec: 'subrip', IsDefault: true, DisplayTitle: 'Japanese - SubRip' });
  assert.deepEqual({ ...srt, raw: undefined }, { id: 3, lang: 'jpn', label: 'Japanese - SubRip', forced: false, extra: false, rank: 3, raw: undefined });
  assert.equal(jellyfinTrack({ Index: 1, Language: 'jpn', Codec: 'ass' }).rank, 0);
  assert.equal(jellyfinTrack({ Index: 1, Language: 'jpn', Codec: 'webvtt' }).rank, 2);
  assert.equal(jellyfinTrack({ Index: 1, Language: 'jpn', Title: 'Signs & Songs' }).extra, true);
  assert.equal(jellyfinTrack({ Index: 1, Language: 'jpn', DisplayTitle: 'Commentary' }).extra, true);
  assert.equal(jellyfinTrack({ Index: 1, Language: 'jpn', IsForced: true }).forced, true);
  assert.equal(jellyfinTrack({ Index: 7 }).lang, '');                                  // a track with no language
  assert.equal(jellyfinTrack({ Index: 7 }).label, 'Track 7');
});

test('only text subtitle streams are listed; audio and image-based ones are not', () => {
  const list = textTracks([
    { Index: 0, Type: 'Video' }, { Index: 1, Type: 'Audio', Language: 'jpn' },
    { Index: 2, Type: 'Subtitle', Language: 'jpn', Codec: 'subrip' },
    { Index: 3, Type: 'Subtitle', Language: 'eng', Codec: 'hdmv_pgs_subtitle', IsTextSubtitleStream: false },
    { Index: 4, Type: 'Subtitle', Language: 'eng', Codec: 'ass', IsTextSubtitleStream: true },
  ]);
  assert.deepEqual(list.map((x) => x.id), [2, 4]);
  assert.deepEqual(textTracks(undefined), []);
});

test('Netflix manifest tracks become common tracks: plain subtitles outrank closed captions, forced stays forced', () => {
  const sub = netflixTrack({ id: 'T:a', lang: 'ko', kind: 'subtitles', forced: false, format: 'imsc1.1', url: 'u' });
  const cc = netflixTrack({ id: 'T:b', lang: 'ko', kind: 'closedcaptions', forced: false, format: 'imsc1.1', url: 'u' });
  assert.deepEqual([sub.rank, cc.rank], [2, 0]);
  assert.equal(pickTrack([cc, sub], ['ko']).id, 'T:a');                          // whatever the order they came in
  assert.equal(pickTrack([sub, cc], ['ko']).id, 'T:a');
  const forced = netflixTrack({ id: 'T:c', lang: 'ko', kind: 'subtitles', forced: true });
  assert.equal(pickTrack([forced, cc], ['ko']).id, 'T:b');                       // a forced-only track loses even to captions
  assert.equal(sub.raw.url, 'u');                                                // the original is kept for downloading
  assert.equal(sub.extra, false);
});

test('Netflix title ids come from the address', () => {
  assert.equal(movieIdFromPath('/watch/82942168'), '82942168');
  assert.equal(movieIdFromPath('/watch/83080515/'), '83080515');
  assert.equal(movieIdFromPath('/browse'), null);
  assert.equal(movieIdFromPath('/title/123'), null);
  assert.equal(movieIdFromPath(''), null);
});

test('the two adapters expose the same shape', () => {
  for (const a of [jellyfin, netflix]) {
    for (const fn of ['findVideo', 'currentItem', 'forget', 'open', 'seekTo']) assert.equal(typeof a[fn], 'function', `${a.name}.${fn}`);
    assert.equal(typeof a.name, 'string');
    // where the bar and panel make room: selectors of the player box, and of controls fixed to the window's bottom
    // and the site's own subtitle renderers, hidden while Subpair is on
    for (const list of [a.layout.player, a.layout.osd, a.layout.hide]) assert.ok(Array.isArray(list) && list.every((s) => typeof s === 'string' && s), `${a.name}.layout`);
    assert.ok(a.layout.player.length > 0, `${a.name} must name the player box it shrinks`);
    assert.ok(a.layout.hide.length > 0, `${a.name} must name its own subtitle renderer`);
  }
});

// Sets page globals (location, localStorage) for one test and always puts the old ones back.
async function withGlobals(globals, fn) {
  const saved = Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  try { return await fn(); } finally {
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}

test('Netflix: the current item is the address\'s title id, or nothing off the watch page', async () => {
  await withGlobals({ location: { pathname: '/watch/555', hostname: 'www.netflix.com' } }, async () => {
    assert.deepEqual(await netflix.currentItem(), { id: '555' });
  });
  await withGlobals({ location: { pathname: '/browse', hostname: 'www.netflix.com' } }, async () => {
    assert.equal(await netflix.currentItem(), null);
    assert.equal(netflix.findVideo(), null);                                          // not even looked for off the watch page
  });
});

test('Netflix title: the text of nested elements is joined with spaces, not glued', () => {
  const text = (t) => ({ nodeType: 3, nodeValue: t });
  const el = (...childNodes) => ({ nodeType: 1, childNodes });
  const title = el(el(text('무쌍한다')), el(text(' 1화 ')), el(el(text('중기사')), text(' 엘마')), text('\n'));
  assert.equal(joinedText(title), '무쌍한다 1화 중기사 엘마');
  assert.equal(joinedText(null), '');
});

test('Jellyfin server address: the path before the web client\'s /web/ folder, even when a prefix contains "web"', async () => {
  const at = (pathname) => withGlobals({ location: { origin: 'https://h', pathname } }, () => serverBase());
  assert.equal(await at('/web/index.html'), 'https://h');
  assert.equal(await at('/web/'), 'https://h');
  assert.equal(await at('/jellyfin/web/index.html'), 'https://h/jellyfin');
  assert.equal(await at('/webapps/jellyfin/web/index.html'), 'https://h/webapps/jellyfin');
});

test('Jellyfin: no saved login is a clear "not logged in" error, not a crash', async () => {
  const storage = { getItem: () => null };
  await withGlobals({ location: { origin: 'https://h', pathname: '/web/' }, localStorage: storage }, async () => {
    assert.equal(jellyfin.findVideo(), null);                                         // not a Jellyfin page as far as we can tell
    await assert.rejects(jellyfin.open('a'.repeat(32), null), /not logged in to Jellyfin/);
  });
});

test('Jellyfin: the item and media source come from the stream address; an unchanged video is not looked up again', async () => {
  const id = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
  const video = { currentSrc: `http://x/Videos/${id}/stream.mkv?MediaSourceId=ms%201&static=true` };
  jellyfin.forget();
  assert.deepEqual(await jellyfin.currentItem(video, null), { id, hint: 'ms 1' });
  assert.deepEqual(await jellyfin.currentItem(video, id), { id });                       // same address as last time: nothing to look up
  jellyfin.forget();
  assert.deepEqual(await jellyfin.currentItem(video, id), { id, hint: 'ms 1' });         // after forget() it asks again
  const next = { currentSrc: `http://x/Videos/${'b'.repeat(32)}/stream.mkv?MediaSourceId=ms2` };
  assert.deepEqual(await jellyfin.currentItem(next, id), { id: 'b'.repeat(32), hint: 'ms2' });
});

test('Jellyfin: the next episode crosses into the next season, skips missing ones, and a movie has none; the season lists its episodes', async () => {
  const creds = JSON.stringify({ Servers: [{ AccessToken: 'tok', UserId: 'u1', ManualAddress: 'https://h' }] });
  const asked = [];
  const items = { e1: { SeriesId: 's', SeasonId: 'z1' }, e9: { SeriesId: 's', SeasonId: 'z1' }, m: {} };
  const fetch = async (url) => {
    asked.push(url);
    const u = new URL(url);
    const json = (v) => ({ ok: true, json: async () => v });
    const item = /\/Users\/u1\/Items\/([^/?]+)$/.exec(u.pathname);
    if (item) return json(items[item[1]]);
    if (u.pathname === '/Shows/s/Episodes' && u.searchParams.get('StartItemId') === 'e1') return json({ Items: [{ Id: 'e1' }, { Id: 'e2', LocationType: 'FileSystem' }] });
    if (u.pathname === '/Shows/s/Episodes' && u.searchParams.get('StartItemId') === 'e9') return json({ Items: [{ Id: 'e9' }, { Id: 'e10', LocationType: 'Virtual' }] });
    if (u.pathname === '/Shows/s/Episodes' && u.searchParams.get('SeasonId') === 'z1') return json({ Items: [{ Id: 'e1' }, { Id: 'e2' }, { Id: 'e3', LocationType: 'Virtual' }] });
    return { ok: false, status: 404 };
  };
  await withGlobals({ location: { origin: 'https://h', pathname: '/web/' }, localStorage: { getItem: () => creds }, fetch }, async () => {
    assert.deepEqual(await jellyfin.nextItem('e1'), { id: 'e2' });
    assert.ok(asked.some((u) => u.includes('StartItemId=e1') && u.includes('Limit=2')));
    assert.equal(await jellyfin.nextItem('e9'), null);                                      // only a missing episode follows
    assert.equal(await jellyfin.nextItem('m'), null);                                       // a movie
    assert.deepEqual(await jellyfin.seasonItems('e1'), [{ id: 'e1' }, { id: 'e2' }]);
    assert.equal(await jellyfin.ready('e2'), true);
  });
});
