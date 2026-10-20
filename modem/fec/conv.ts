/**
 * Rate-1/2, constraint-length-7 convolutional code (generators 171/133 octal, the NASA/802.11
 * code, free distance 10) with optional puncturing to 2/3 or 3/4, and a soft-decision Viterbi
 * decoder over LLRs (ln P(0)/P(1)). Two termination modes:
 *  - 'zero': 6 tail bits flush the encoder (12 extra coded bits at r=1/2);
 *  - 'tailbiting': encoder starts in the state given by the last 6 data bits, so no tail is sent;
 *    decoded with a circular (wrap-around) Viterbi. Used for short blocks such as the header,
 *    where 12 coded bits are a large fraction of the block.
 */
export const K = 7;
const NSTATES = 1 << (K - 1);
const G0 = 0o171;
const G1 = 0o133;

export type Termination = 'zero' | 'tailbiting';
export type CodeRate = '1/2' | '2/3' | '3/4';

/** Puncturing patterns (per mother-code output pair, 1 = transmit), standard 802.11 patterns. */
const PUNCT: Record<CodeRate, number[]> = {
  '1/2': [1, 1],
  '2/3': [1, 1, 1, 0],
  '3/4': [1, 1, 1, 0, 0, 1],
};

function parity(x: number): number {
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
}

// output pair for (state, input): state holds the previous K−1 inputs, newest in the MSB
const OUT0 = new Uint8Array(NSTATES * 2);
const OUT1 = new Uint8Array(NSTATES * 2);
const NEXT = new Uint8Array(NSTATES * 2);
for (let s = 0; s < NSTATES; s++) {
  for (let b = 0; b < 2; b++) {
    const reg = (b << (K - 1)) | s; // K bits: newest input in MSB
    OUT0[s * 2 + b] = parity(reg & G0);
    OUT1[s * 2 + b] = parity(reg & G1);
    NEXT[s * 2 + b] = reg >> 1;
  }
}

/** Number of coded bits for `n` data bits. */
export function codedLength(n: number, rate: CodeRate, term: Termination): number {
  const steps = n + (term === 'zero' ? K - 1 : 0);
  const pat = PUNCT[rate];
  let c = 0;
  for (let i = 0; i < 2 * steps; i++) c += pat[i % pat.length];
  return c;
}

export function convEncode(bits: ArrayLike<number>, rate: CodeRate = '1/2', term: Termination = 'zero'): Uint8Array {
  const n = bits.length;
  let s = 0;
  if (term === 'tailbiting') {
    // start state = last K−1 data bits (newest = last bit in MSB)
    for (let i = n - (K - 1); i < n; i++) s = ((i >= 0 ? bits[i] & 1 : 0) << (K - 2)) | (s >> 1);
  }
  const steps = n + (term === 'zero' ? K - 1 : 0);
  const pat = PUNCT[rate];
  const out: number[] = [];
  let pi = 0;
  for (let i = 0; i < steps; i++) {
    const b = i < n ? bits[i] & 1 : 0;
    const o = [OUT0[s * 2 + b], OUT1[s * 2 + b]];
    for (const v of o) {
      if (pat[pi % pat.length]) out.push(v);
      pi++;
    }
    s = NEXT[s * 2 + b];
  }
  return Uint8Array.from(out);
}

/** Expand punctured LLRs back to mother-code positions (erasures = 0). */
function depuncture(llr: ArrayLike<number>, steps: number, rate: CodeRate): Float64Array {
  const pat = PUNCT[rate];
  const full = new Float64Array(2 * steps);
  let j = 0;
  for (let i = 0; i < 2 * steps; i++) if (pat[i % pat.length]) full[i] = llr[j++] ?? 0;
  return full;
}

/** Core Viterbi over `steps` trellis steps; returns survivor decisions and final metrics. */
function viterbiCore(full: Float64Array, steps: number, init: Float64Array): { dec: Uint8Array; metric: Float64Array } {
  let pm = Float64Array.from(init);
  let nm = new Float64Array(NSTATES);
  const dec = new Uint8Array(steps * NSTATES); // stores the predecessor's dropped LSB
  for (let t = 0; t < steps; t++) {
    nm.fill(-Infinity);
    const l0 = full[2 * t] / 2;
    const l1 = full[2 * t + 1] / 2;
    for (let s = 0; s < NSTATES; s++) {
      const m = pm[s];
      if (m === -Infinity) continue;
      for (let b = 0; b < 2; b++) {
        const idx = s * 2 + b;
        // +llr/2 if the expected bit is 0, −llr/2 if 1
        const bm = (OUT0[idx] ? -l0 : l0) + (OUT1[idx] ? -l1 : l1);
        const ns = NEXT[idx];
        const v = m + bm;
        if (v > nm[ns]) {
          nm[ns] = v;
          dec[t * NSTATES + ns] = s & 1;
        }
      }
    }
    const tmp = pm;
    pm = nm;
    nm = tmp;
  }
  return { dec, metric: pm };
}

function traceback(dec: Uint8Array, steps: number, endState: number): Uint8Array {
  const bits = new Uint8Array(steps);
  let s = endState;
  for (let t = steps - 1; t >= 0; t--) {
    bits[t] = (s >> (K - 2)) & 1; // newest input is the MSB of the state
    const lsb = dec[t * NSTATES + s];
    s = ((s << 1) & (NSTATES - 1)) | lsb;
  }
  return bits;
}

export interface ViterbiResult {
  bits: Uint8Array;
  /** Path metric margin (best − second-best final state), a confidence indicator. */
  margin: number;
}

export function viterbiDecode(llr: ArrayLike<number>, n: number, rate: CodeRate = '1/2', term: Termination = 'zero'): ViterbiResult {
  if (term === 'zero') {
    const steps = n + K - 1;
    const full = depuncture(llr, steps, rate);
    const init = new Float64Array(NSTATES).fill(-Infinity);
    init[0] = 0;
    const { dec, metric } = viterbiCore(full, steps, init);
    const bits = traceback(dec, steps, 0).subarray(0, n);
    let second = -Infinity;
    for (let s = 1; s < NSTATES; s++) second = Math.max(second, metric[s]);
    return { bits: Uint8Array.from(bits), margin: metric[0] - second };
  }
  // circular Viterbi: decode three copies with uniform start, keep the middle one
  const full1 = depuncture(llr, n, rate);
  const full = new Float64Array(6 * n);
  full.set(full1, 0);
  full.set(full1, 2 * n);
  full.set(full1, 4 * n);
  const init = new Float64Array(NSTATES);
  const { dec, metric } = viterbiCore(full, 3 * n, init);
  let best = 0;
  for (let s = 1; s < NSTATES; s++) if (metric[s] > metric[best]) best = s;
  let second = -Infinity;
  for (let s = 0; s < NSTATES; s++) if (s !== best) second = Math.max(second, metric[s]);
  const all = traceback(dec, 3 * n, best);
  return { bits: Uint8Array.from(all.subarray(n, 2 * n)), margin: metric[best] - second };
}
