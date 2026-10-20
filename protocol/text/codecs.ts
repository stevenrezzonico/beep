import { ArithEncoder, ArithDecoder } from './arith.ts';
import { getModel, tokenize, symbolText, SYM_ESC, SYM_EOS, NSYM, CTX_START, type Model } from './model.ts';
import { BitWriter, BitReader } from '../bits.ts';

/**
 * Text codecs. `compact` is the production codec (content type 0); `utf8` is content type 1
 * and wins for non-Latin scripts. The others exist for the comparison in docs/PROTOCOL.md.
 * All return/consume bit arrays; the caller packs them into the packet.
 */

// ------------------------------------------------------------------ compact (order-1 arithmetic)

function writeCp(enc: ArithEncoder, cp: number): void {
  // Exp-Golomb of cp−128 (ESC is only used for code points outside printable ASCII)
  const x = Math.max(0, cp - 128) + 1;
  const n = Math.floor(Math.log2(x));
  for (let i = 0; i < n; i++) enc.encodeBit(0);
  for (let i = n; i >= 0; i--) enc.encodeBit(Math.floor(x / 2 ** i) & 1);
  if (cp < 128) throw new Error('unexpected control character');
}

function readCp(dec: ArithDecoder): number {
  let n = 0;
  while (dec.decodeBit() === 0) if (++n > 24) throw new Error('bad code point');
  let x = 1;
  for (let i = 0; i < n; i++) x = 2 * x + dec.decodeBit();
  return x - 1 + 128;
}

export function compactEncode(s: string, model: Model = getModel(), useDict = true): number[] {
  const enc = new ArithEncoder();
  let ctx = CTX_START;
  const toks = tokenize(s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' '), useDict);
  for (const t of [...toks, { sym: SYM_EOS }]) {
    const c = model.cum[ctx];
    enc.encode(c[t.sym], c[t.sym + 1], c[NSYM]);
    if (t.sym === SYM_ESC) writeCp(enc, t.cp!);
    ctx = t.sym;
  }
  return enc.finish();
}

export function compactDecode(bits: ArrayLike<number>, model: Model = getModel(), maxChars = 4096): string {
  const dec = new ArithDecoder(bits);
  let ctx = CTX_START;
  let out = '';
  for (let n = 0; n < maxChars; n++) {
    const c = model.cum[ctx];
    const total = c[NSYM];
    const t = dec.target(total);
    // binary search the symbol whose cumulative range contains t
    let lo = 0, hi = NSYM - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    dec.consume(c[lo], c[lo + 1], total);
    if (lo === SYM_EOS) return out;
    out += lo === SYM_ESC ? String.fromCodePoint(readCp(dec)) : symbolText(lo);
    ctx = lo;
  }
  throw new Error('no end of text');
}

// ------------------------------------------------------------------ baselines

export function utf8Bits(s: string): number {
  return new TextEncoder().encode(s).length * 8;
}

const SIX = ' abcdefghijklmnopqrstuvwxyz0123456789.,!?\'-:/@#()&+=";_*%$\n~<>[]';
/** 6-bit alphabet: lower case, digits, punctuation; SHIFT (60) uppercases the next letter, ESC (63) + Exp-Golomb code point. */
export function sixBitEncode(s: string): number[] {
  const w = new BitWriter();
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const i = SIX.indexOf(lower);
    if (i >= 0 && ch.length === 1) {
      if (ch !== lower) w.write(60, 6);
      w.write(i, 6);
    } else {
      w.write(63, 6);
      w.expGolomb(ch.codePointAt(0)!);
    }
  }
  return w.toBits();
}

export function sixBitDecode(bits: number[]): string {
  const r = new BitReader(bits);
  let out = '';
  let shift = false;
  while (r.remaining >= 6) {
    const v = r.read(6);
    if (v === 60) shift = true;
    else if (v === 63) out += String.fromCodePoint(r.expGolomb());
    else {
      const ch = SIX[v] ?? '';
      out += shift ? ch.toUpperCase() : ch;
      shift = false;
    }
  }
  return out;
}

/** Static order-0 Huffman over the same alphabet (code lengths only — for the size comparison). */
export function huffmanBits(s: string, model: Model = getModel(false)): number {
  const lengths = huffmanLengths(model);
  let bits = 0;
  for (const t of [...tokenize(s, false), { sym: SYM_EOS }]) {
    bits += lengths[t.sym];
    if (t.sym === SYM_ESC) bits += 2 * Math.floor(Math.log2(Math.max(0, t.cp! - 128) + 1)) + 1;
  }
  return bits;
}

function huffmanLengths(model: Model): number[] {
  // order-0 frequencies from the start-context-independent order0Bits
  const w = Array.from(model.order0Bits, (b) => 2 ** -b);
  type Node = { w: number; syms: number[] };
  let nodes: Node[] = w.map((x, i) => ({ w: x, syms: [i] }));
  const len = new Array(w.length).fill(0);
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.w - b.w);
    const [a, b] = nodes.splice(0, 2);
    for (const s of [...a.syms, ...b.syms]) len[s]++;
    nodes.push({ w: a.w + b.w, syms: [...a.syms, ...b.syms] });
  }
  return len;
}
