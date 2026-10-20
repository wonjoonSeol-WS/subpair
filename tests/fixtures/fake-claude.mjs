// Stands in for the claude CLI in tests: the prompt arrives on stdin, the system prompt in --system-prompt-file.
// By the prompt: "HANG" never answers, "FAIL" exits 1 with an error naming the home folder, "SPLIT" answers with a Korean
// word written in two pieces that cut a character in half; anything else is answered as
// "<first word of the system prompt>|<prompt>|<arguments joined with commas>".
import fs from 'node:fs';
import os from 'node:os';

const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('1.0.0 (fake)\n'); process.exit(0); }
const promptFile = args[args.indexOf('--system-prompt-file') + 1];

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  if (input.includes('HANG')) { setInterval(() => {}, 1000); return; }
  if (input.includes('FAIL')) { process.stderr.write(`cannot read ${os.homedir()}${'/'}.claude/settings.json\n`); process.exit(1); }
  if (input.includes('SPLIT')) {
    const bytes = Buffer.from('번역', 'utf8');
    process.stdout.write(bytes.subarray(0, 2));                       // the first character is 3 bytes long
    await new Promise((r) => setTimeout(r, 100));
    process.stdout.write(bytes.subarray(2));
    return;
  }
  process.stdout.write(`${fs.readFileSync(promptFile, 'utf8').split(' ')[0]}|${input}|${args.join(',')}`);
});
