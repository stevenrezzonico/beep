import { gfMul, gfInv } from '../modem/fec/rs.ts';
import { Rng } from '../src/dsp/prng.ts';

/**
 * Systematic random linear erasure code over GF(256) (a rateless "fountain"): fragments
 * 0…k−1 are the source fragments themselves; any fragment index ≥ k is a repair fragment whose
 * coefficients are derived from (messageId, index) so receivers regenerate them without any
 * signalling. Any k linearly independent fragments recover the message — for random GF(256)
 * coefficients that is k fragments with probability ≈ 99.6%, k+1 with ≈ 99.998%.
 *
 * Why rateless rather than Reed–Solomon over fragments: in a broadcast with no back-channel the
 * sender can keep transmitting new repair fragments for as long as it likes (a carousel), each
 * one useful to every receiver regardless of which fragments it lost, and a receiver that joins
 * late still completes after k receptions. RS needs n ≤ 255 fixed in advance.
 */
export function repairCoefficients(msgKey: number, index: number, k: number): Uint8Array {
  const rng = new Rng((msgKey * 0x9e3779b1) ^ (index * 0x85ebca6b) ^ 0x2545f491);
  const c = new Uint8Array(k);
  for (let j = 0; j < k; j++) c[j] = 1 + rng.int(255); // non-zero
  return c;
}

export function encodeFragment(src: Uint8Array[], index: number, msgKey: number): Uint8Array {
  const k = src.length;
  if (index < k) return src[index];
  const F = src[0].length;
  const c = repairCoefficients(msgKey, index, k);
  const out = new Uint8Array(F);
  for (let j = 0; j < k; j++) {
    const cj = c[j];
    const s = src[j];
    for (let i = 0; i < F; i++) out[i] ^= gfMul(cj, s[i]);
  }
  return out;
}

/** Incremental Gaussian-elimination decoder. */
export class RlncDecoder {
  readonly k: number;
  readonly size: number;
  private readonly msgKey: number;
  // pivot rows: rows[p] has coefficient 1 at column p and 0 at other pivot columns
  private readonly rows: (Uint8Array | null)[];
  private readonly data: (Uint8Array | null)[];
  private readonly seen = new Set<number>();
  rank = 0;
  received = 0;
  duplicates = 0;

  constructor(k: number, size: number, msgKey: number) {
    this.k = k;
    this.size = size;
    this.msgKey = msgKey;
    this.rows = new Array(k).fill(null);
    this.data = new Array(k).fill(null);
  }

  get complete(): boolean {
    return this.rank === this.k;
  }

  /** Indices of source fragments not yet known directly (for progress display). */
  missingSources(): number[] {
    const m: number[] = [];
    for (let i = 0; i < this.k; i++) if (!this.seen.has(i)) m.push(i);
    return m;
  }

  /** Add a fragment; returns true if it increased the rank (was innovative). */
  add(index: number, payload: Uint8Array): boolean {
    if (payload.length !== this.size) return false;
    if (this.seen.has(index)) {
      this.duplicates++;
      return false;
    }
    this.seen.add(index);
    this.received++;
    if (this.complete) return false;
    let coef: Uint8Array;
    if (index < this.k) {
      coef = new Uint8Array(this.k);
      coef[index] = 1;
    } else coef = repairCoefficients(this.msgKey, index, this.k);
    const d = Uint8Array.from(payload);
    // eliminate existing pivots
    for (let p = 0; p < this.k; p++) {
      const c = coef[p];
      const row = this.rows[p];
      if (!c || !row) continue;
      const dr = this.data[p]!;
      for (let j = 0; j < this.k; j++) coef[j] ^= gfMul(c, row[j]);
      for (let i = 0; i < this.size; i++) d[i] ^= gfMul(c, dr[i]);
    }
    let piv = -1;
    for (let j = 0; j < this.k; j++) if (coef[j] && !this.rows[j]) { piv = j; break; }
    if (piv < 0) return false; // linearly dependent
    const inv = gfInv(coef[piv]);
    for (let j = 0; j < this.k; j++) coef[j] = gfMul(coef[j], inv);
    for (let i = 0; i < this.size; i++) d[i] = gfMul(d[i], inv);
    // back-substitute into existing rows to keep reduced form
    for (let p = 0; p < this.k; p++) {
      const row = this.rows[p];
      if (!row || !row[piv]) continue;
      const c = row[piv];
      const dr = this.data[p]!;
      for (let j = 0; j < this.k; j++) row[j] ^= gfMul(c, coef[j]);
      for (let i = 0; i < this.size; i++) dr[i] ^= gfMul(c, d[i]);
    }
    this.rows[piv] = coef;
    this.data[piv] = d;
    this.rank++;
    return true;
  }

  /** Source fragments, once complete. */
  result(): Uint8Array[] | null {
    if (!this.complete) return null;
    return this.data.map((d) => d!);
  }
}
