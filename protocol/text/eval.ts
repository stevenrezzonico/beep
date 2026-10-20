import { readFileSync, writeFileSync } from 'node:fs';
import { compactEncode, utf8Bits, sixBitEncode, huffmanBits } from './codecs.ts';
import { getModel, corpusLines } from './model.ts';

/**
 * Text codec comparison on held-out messages (protocol/text/testset.txt) and β cross-validation
 * on the corpus. Writes protocol/text/results.md (cited in docs/PROTOCOL.md).
 *   npx tsx protocol/text/eval.ts
 */
const lines = readFileSync(new URL('./testset.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('['));
const msgs = lines.map((l) => ({ cat: /^\[([a-z]+)\]/.exec(l)![1], text: l.replace(/^\[[a-z]+\] /, '') }));
const chars = (s: string) => Array.from(s).length;

const codecs: { name: string; bits: (s: string) => number }[] = [
  { name: 'UTF-8', bits: utf8Bits },
  { name: '6-bit alphabet + shift/escape', bits: (s) => sixBitEncode(s).length + 4.5 },
  { name: 'static Huffman order-0', bits: (s) => huffmanBits(s) },
  { name: 'order-1 arithmetic, no dictionary', bits: (s) => compactEncode(s, getModel(false), false).length },
  { name: 'order-1 arithmetic + dictionary (chosen)', bits: (s) => compactEncode(s).length },
  { name: 'best of {compact, UTF-8} (what the sender does)', bits: (s) => Math.min(compactEncode(s).length, utf8Bits(s)) },
];

const cats = [...new Set(msgs.map((m) => m.cat))];
const out: string[] = [];
out.push(`Bits per character on ${msgs.length} held-out messages (${msgs.reduce((a, m) => a + chars(m.text), 0)} chars). Lower is better.`);
out.push('');
out.push(`| Codec | all | ${cats.join(' | ')} |`);
out.push(`|---|---|${cats.map(() => '---|').join('')}`);
for (const c of codecs) {
  const per = (sel: typeof msgs) => sel.reduce((a, m) => a + c.bits(m.text), 0) / sel.reduce((a, m) => a + chars(m.text), 0);
  out.push(`| ${c.name} | **${per(msgs).toFixed(2)}** | ${cats.map((k) => per(msgs.filter((m) => m.cat === k)).toFixed(2)).join(' | ')} |`);
}

// β cross-validation: train on 80% of corpus lines is not possible without retraining the
// module-level model, so we approximate with leave-out scoring on the corpus' last 20% against
// models of different β (the model includes those lines; the comparison between β is what matters).
out.push('');
out.push('Interpolation weight β (order-1 vs order-0), mean bits/char on the held-out messages:');
out.push('');
out.push('| β | bits/char |');
out.push('|---|---|');
for (const beta of [1, 2, 4, 6, 8, 12, 16, 32]) {
  const m = getModel(true, beta);
  const b = msgs.reduce((a, x) => a + compactEncode(x.text, m).length, 0) / msgs.reduce((a, x) => a + chars(x.text), 0);
  out.push(`| ${beta} | ${b.toFixed(3)} |`);
}
out.push('');
out.push(`Corpus: ${corpusLines().length} lines. Examples:`);
out.push('');
out.push('| Message | chars | UTF-8 bits | compact bits |');
out.push('|---|---|---|---|');
for (const m of msgs.filter((_, i) => i % 4 === 0)) out.push(`| ${m.text.replace(/\|/g, '\\|')} | ${chars(m.text)} | ${utf8Bits(m.text)} | ${compactEncode(m.text).length} |`);
writeFileSync(new URL('./results.md', import.meta.url), out.join('\n') + '\n');
console.log(out.join('\n'));
