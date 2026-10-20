import { Rng } from '../../src/dsp/prng.ts';

/**
 * Bit interleaver for bit-interleaved coded modulation. A fixed pseudo-random permutation
 * (seeded by the block length, so both ends derive it without signalling) spreads a burst of
 * corrupted symbols — a click, or a reverberant smear over consecutive chirps — across the whole
 * codeword, where the Viterbi decoder sees isolated errors instead of a burst it cannot fix.
 */
const cache = new Map<number, Uint32Array>();

export function permutation(n: number): Uint32Array {
  let p = cache.get(n);
  if (p) return p;
  p = new Uint32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const rng = new Rng(0x5eed ^ n);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  cache.set(n, p);
  return p;
}

/** out[p[i]] = in[i] */
export function interleave<T extends Uint8Array | Float64Array>(x: T): T {
  const p = permutation(x.length);
  const y = new (x.constructor as { new (n: number): T })(x.length);
  for (let i = 0; i < x.length; i++) y[p[i]] = x[i];
  return y;
}

export function deinterleave<T extends Uint8Array | Float64Array>(y: T): T {
  const p = permutation(y.length);
  const x = new (y.constructor as { new (n: number): T })(y.length);
  for (let i = 0; i < y.length; i++) x[i] = y[p[i]];
  return x;
}
