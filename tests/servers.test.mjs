import test from 'node:test';
import assert from 'node:assert/strict';
import { serverOrigin, isNetflix } from '../src/servers.js';

test('a server address typed in the options page becomes the origin the browser grants', () => {
  assert.equal(serverOrigin('http://192.168.0.10:8096/web/index.html#/home'), 'http://192.168.0.10:8096');
  assert.equal(serverOrigin(' jellyfin.local:8096 '), 'http://jellyfin.local:8096');        // no scheme typed: http
  assert.equal(serverOrigin('https://media.example.com/jellyfin/web/'), 'https://media.example.com');
  assert.equal(serverOrigin('localhost:8096'), 'http://localhost:8096');                    // a server on this computer is a server too
  for (const bad of ['', '   ', 'ftp://x.example', 'file:///C:/x', 'javascript:alert(1)', 'http://']) assert.equal(serverOrigin(bad), '', bad);
});

test('Netflix is never a Jellyfin server; this computer can be', () => {
  for (const o of ['https://www.netflix.com', 'https://netflix.com']) assert.equal(isNetflix(o), true, o);
  for (const o of ['http://localhost:8096', 'http://127.0.0.1:8096', 'https://netflix.com.evil.example', 'http://192.168.0.10:8096']) assert.equal(isNetflix(o), false, o);
});
