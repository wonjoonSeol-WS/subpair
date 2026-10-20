// Stands in for Luna's 32-bit ezTrans helper in tests (run with node, Windows named pipe like the real one).
//   argv: <this script> eztrans <pipe> <event> <marker file>
// Each start appends a line to the marker file, so a test can count how often the helper was (re)started.
// Behaviour by text: "HANG" never answers, "DIE" exits the process, "BADLEN" answers with a huge length, "EMPTY" answers
// length 0 (the engine failing), anything else is answered as "KO:" plus the text.
import net from 'node:net';
import fs from 'node:fs';

const [, , , pipe, , marker] = process.argv;
fs.appendFileSync(marker, 'start\n');

const reply = (sock, text) => {
  const out = Buffer.from(text, 'utf16le');
  const h = Buffer.alloc(4);
  h.writeInt32LE(out.length);
  sock.write(h);
  if (out.length) sock.write(out);
};

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const n = buf.readInt32LE(0);
      if (buf.length < 4 + n) return;
      const text = buf.subarray(4, 4 + n).toString('utf16le');
      buf = buf.subarray(4 + n);
      if (text.includes('HANG')) continue;
      if (text.includes('DIE')) process.exit(1);
      if (text.includes('BADLEN')) { const h = Buffer.alloc(4); h.writeInt32LE(0x7fffffff); sock.write(h); continue; }
      if (text.includes('EMPTY')) { reply(sock, ''); continue; }
      reply(sock, `KO:${text}`);
    }
  });
  sock.on('error', () => {});
}).listen(pipe);
