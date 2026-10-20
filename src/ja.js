// Turns kuromoji (IPADIC) morphemes into learner-sized "words": a conjugated verb or adjective stays in one piece
// (食べ+たかっ+た -> 食べたかった), noun suffixes attach (魔王+軍 -> 魔王軍), particles stay separate.
// Pure functions over kuromoji token objects, so they can be tested in Node without a browser.

const TE = new Set(['て', 'で']);

const isVerb = (t) => t.pos === '動詞';
const isAdj = (t) => t.pos === '形容詞';
const isNoun = (t) => t.pos === '名詞';
const isAux = (t) => t.pos === '助動詞';
const isSuffix = (t) => t.pos_detail_1 === '接尾';
const isDependent = (t) => (isVerb(t) || isAdj(t)) && t.pos_detail_1 === '非自立';   // いる, くれる, ほしい...
const isTeParticle = (t) => t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && TE.has(t.surface_form);
// ば after a conditional form (行かなけれ+ば) belongs to the verb
const isConditionalBa = (t, prev) => t.pos === '助詞' && t.surface_form === 'ば' && prev && prev.conjugated_form === '仮定形';

// Part-of-speech category used for coloring.
export function categoryOf(t) {
  if (t.pos === '記号' || t.pos === 'フィラー') return 'symbol';
  if (isVerb(t)) return 'verb';
  if (isAdj(t)) return 'adj';
  if (isNoun(t)) return t.pos_detail_1 === '形容動詞語幹' ? 'adj' : 'noun';
  if (t.pos === '副詞') return 'adv';
  if (t.pos === '助詞' || isAux(t)) return 'particle';
  return 'other';
}

// tokens: kuromoji tokenizer.tokenize() output. Returns [{ text, cat, word, base, reading }].
export function chunkTokens(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    let end = i + 1;
    let first = head;

    if (head.pos === '接頭詞' && end < tokens.length && tokens[end].pos !== '記号') {
      // お/ご + noun etc.: the prefix belongs to the word that follows it
      first = tokens[end];
      end++;
    }

    if (isVerb(first) || isAdj(first)) {
      while (end < tokens.length) {
        const n = tokens[end];
        if (isAux(n) || isDependent(n) || (isSuffix(n) && (isVerb(n) || isAdj(n)))) { end++; continue; }
        // 言っ+て, 食べ+て: the te-form particle is part of the verb (a following いる/くれる/ほしい joins it above)
        if (isTeParticle(n)) { end++; continue; }
        if (isConditionalBa(n, tokens[end - 1])) { end++; continue; }
        break;
      }
    } else if (isNoun(first)) {
      // noun + suffix (様, さん, たち, 的...), and number sequences (一, 人)
      while (end < tokens.length) {
        const n = tokens[end];
        if (isNoun(n) && (isSuffix(n) || (first.pos_detail_1 === '数' && n.pos_detail_1 === '数'))) { end++; continue; }
        break;
      }
    }

    const toks = tokens.slice(i, end);
    const text = toks.map((t) => t.surface_form).join('');
    out.push({
      text,
      cat: categoryOf(first),
      word: first.pos !== '記号',
      // dictionary form only for conjugating words (verbs, adjectives); everything else keeps its text
      base: (isVerb(first) || isAdj(first)) && first.basic_form && first.basic_form !== '*'
        ? toks.slice(0, toks.indexOf(first)).map((t) => t.surface_form).join('') + first.basic_form
        : text,
      reading: toks.map((t) => (t.reading && t.reading !== '*' ? t.reading : t.surface_form)).join(''),
    });
    i = end;
  }
  return out;
}
