import corpus from './corpus.ts';

/**
 * Static character model shared by the compact text codec.
 *
 * Alphabet: printable ASCII (95) + newline + ESC (any other Unicode code point follows as
 * Exp-Golomb bits) + EOS, plus a few multi-character tokens (DICT) that are frequent in the
 * messages people actually send (URLs, common English fragments). Probabilities are an order-1
 * model (previous symbol as context) interpolated with order-0, trained on corpus.txt, quantised
 * to integer frequencies with integer-safe arithmetic so every device builds the identical table.
 */
export const DICT = ['https://', 'http://', 'www.', '.com', '.org', '.net', 'the ', 'ing', 'and ', 'you', 'tion', ' the'];

export const SYM_NL = 95;
export const SYM_ESC = 96;
export const SYM_EOS = 97;
export const SYM_DICT0 = 98;
export const NSYM = SYM_DICT0 + DICT.length;
export const CTX_START = NSYM; // context before the first symbol

/** Tokenise a string into model symbols (greedy longest dictionary match); ESC carries code points. */
export function tokenize(s: string, useDict = true): { sym: number; cp?: number }[] {
  const out: { sym: number; cp?: number }[] = [];
  const cps = Array.from(s);
  let i = 0;
  const joined = s;
  let off = 0; // UTF-16 offset of cps[i]
  while (i < cps.length) {
    let matched = -1;
    if (useDict) {
      let best = 0;
      for (let d = 0; d < DICT.length; d++) {
        const w = DICT[d];
        if (w.length > best && joined.startsWith(w, off)) {
          best = w.length;
          matched = d;
        }
      }
      if (matched >= 0) {
        out.push({ sym: SYM_DICT0 + matched });
        i += DICT[matched].length; // dictionary entries are ASCII
        off += DICT[matched].length;
        continue;
      }
    }
    const ch = cps[i];
    const cp = ch.codePointAt(0)!;
    if (cp >= 32 && cp <= 126) out.push({ sym: cp - 32 });
    else if (cp === 10) out.push({ sym: SYM_NL });
    else out.push({ sym: SYM_ESC, cp });
    i++;
    off += ch.length;
  }
  return out;
}

export function symbolText(sym: number): string {
  if (sym < 95) return String.fromCharCode(sym + 32);
  if (sym === SYM_NL) return '\n';
  if (sym >= SYM_DICT0) return DICT[sym - SYM_DICT0];
  return '';
}

export interface Model {
  /** cum[ctx] has NSYM+1 entries; total = cum[ctx][NSYM]. */
  cum: Uint32Array[];
  order0Bits: Float64Array;
}

const TOTAL = 1 << 16;

function build(useDict: boolean, beta: number): Model {
  const n1 = Array.from({ length: NSYM + 1 }, () => new Float64Array(NSYM));
  const n0 = new Float64Array(NSYM);
  for (const line of corpus.split('\n')) {
    if (!line.trim()) continue;
    let ctx = CTX_START;
    for (const t of [...tokenize(line, useDict), { sym: SYM_EOS }]) {
      n1[ctx][t.sym]++;
      n0[t.sym]++;
      ctx = t.sym;
    }
  }
  let N0 = 0;
  for (const v of n0) N0 += v;
  const p0 = Array.from(n0, (v) => (v + 1) / (N0 + NSYM));
  const cum: Uint32Array[] = [];
  for (let ctx = 0; ctx <= NSYM; ctx++) {
    let nx = 0;
    for (const v of n1[ctx]) nx += v;
    const c = new Uint32Array(NSYM + 1);
    for (let s = 0; s < NSYM; s++) {
      const p = (n1[ctx][s] + beta * p0[s]) / (nx + beta);
      c[s + 1] = c[s] + 1 + Math.floor((TOTAL - NSYM) * p);
    }
    cum.push(c);
  }
  return { cum, order0Bits: Float64Array.from(p0, (p) => -Math.log2(p)) };
}

const cache = new Map<string, Model>();
/**
 * β = 8: bits/char is flat for β in 6…16 on the held-out messages (protocol/text/results.md), so
 * the choice is not sensitive to that set.
 */
export function getModel(useDict = true, beta = 8): Model {
  const key = `${useDict}/${beta}`;
  let m = cache.get(key);
  if (!m) cache.set(key, (m = build(useDict, beta)));
  return m;
}

export function corpusLines(): string[] {
  return corpus.split('\n').filter((l) => l.trim());
}
