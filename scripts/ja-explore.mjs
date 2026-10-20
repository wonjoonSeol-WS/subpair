// Prints how real subtitle lines get chunked, to review the rules by eye. Run: node scripts/ja-explore.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chunkTokens } from '../src/ja.js';
const require = createRequire(import.meta.url);
const DICT = fileURLToPath(new URL('../node_modules/kuromoji/dict/', import.meta.url));      // wherever this is run from
const kuromoji = require('kuromoji');

const lines = [
  'その安定を乱す魔王が',
  '国民よ 顔を上げてくれ！',
  '旅の苦しみは 計り知れない…',
  '悲しみに暮れ 姫を思った',
  '勇者様 しかし 魔王軍は強大ですぞ',
  'われわれが必ず 姫を魔王から救い出す！',
  '食べたかった',
  '見ている',
  '走っていた',
  '美味しくなかった',
  '行かなければならない',
  '人々は 統一国家カイミーンによる 長い治世のもと',
  '笑い合い 幸せに暮らしていた',
  '返してほしくば',
  'お姫様をください',
  '三人の青年が声を上げた',
];

kuromoji.builder({ dicPath: DICT }).build((err, tok) => {
  if (err) throw err;
  for (const l of lines) {
    const chunks = chunkTokens(tok.tokenize(l));
    console.log(l);
    console.log('  ' + chunks.map((c) => `${c.text}<${c.cat}${c.base !== c.text ? ':' + c.base : ''}>`).join(' '));
  }
});
