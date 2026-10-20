/**
 * Common interface for modulation candidates compared in the simulator and on the bench.
 * Every candidate renders bits to a waveform with peak amplitude 1 and demodulates with genie
 * timing (the start time of the first symbol is given) but *no* frequency-offset knowledge, so
 * the comparison isolates modulation robustness from synchronisation design. Soft outputs are
 * LLRs, ln P(b=0)/P(b=1): positive means 0.
 */
export interface Candidate {
  id: string;
  label: string;
  family: string;
  /** Raw (uncoded) bit rate, bits/s. */
  bitRate: number;
  /** Whether the transmit envelope is constant (one tone at a time, no amplitude modulation). */
  constantEnvelope: boolean;
  modulate(bits: Uint8Array, fs: number): Float32Array;
  demodulate(x: Float32Array, fs: number, t0: number, nbits: number): Float64Array;
}

export function hardBits(llr: Float64Array): Uint8Array {
  const b = new Uint8Array(llr.length);
  for (let i = 0; i < llr.length; i++) b[i] = llr[i] < 0 ? 1 : 0;
  return b;
}

/** Raised-cosine edge gain for sample time t within [0, dur] with ramp r (seconds). */
export function edgeGain(t: number, dur: number, r: number): number {
  if (r <= 0) return 1;
  if (t < r) return 0.5 - 0.5 * Math.cos((Math.PI * t) / r);
  if (t > dur - r) return 0.5 - 0.5 * Math.cos((Math.PI * (dur - t)) / r);
  return 1;
}

/** Bits → integers of `k` bits (MSB first), zero-padded. */
export function packSymbols(bits: Uint8Array, k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += k) {
    let v = 0;
    for (let j = 0; j < k; j++) v = (v << 1) | (bits[i + j] ?? 0);
    out.push(v);
  }
  return out;
}

/** ln I0(x), stable for all x ≥ 0. */
export function lnI0(x: number): number {
  if (x < 3.75) {
    const t = (x / 3.75) ** 2;
    return Math.log(
      1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813))))),
    );
  }
  const t = 3.75 / x;
  const p =
    0.39894228 +
    t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))));
  return x - 0.5 * Math.log(x) + Math.log(p);
}

/**
 * Per-bit max-log LLRs for one M-ary orthogonal symbol from bin powers, Gray-mapped
 * (value = gray(bits)). Uses the non-coherent likelihood ln I0(2√Es·|X|/N0).
 */
export function mAryLlr(power: ArrayLike<number>, k: number, es: number, n0: number, gray: (v: number) => number, out: number[]): void {
  const M = 1 << k;
  const metric = new Float64Array(M);
  const a = (2 * Math.sqrt(Math.max(es, 1e-30))) / Math.max(n0, 1e-30);
  for (let v = 0; v < M; v++) metric[v] = lnI0(a * Math.sqrt(power[gray(v)]));
  for (let b = 0; b < k; b++) {
    const mask = 1 << (k - 1 - b);
    let m0 = -Infinity, m1 = -Infinity;
    for (let v = 0; v < M; v++) {
      if (v & mask) m1 = Math.max(m1, metric[v]);
      else m0 = Math.max(m0, metric[v]);
    }
    out.push(m0 - m1);
  }
}

/** Estimate Es and N0 from a list of per-symbol bin-power arrays (peak vs the rest). */
export function estimateEsN0(spectra: ArrayLike<number>[]): { es: number; n0: number } {
  let pk = 0, rest = 0, nr = 0;
  for (const p of spectra) {
    let m = 0, mi = 0, s = 0;
    for (let i = 0; i < p.length; i++) {
      s += p[i];
      if (p[i] > m) { m = p[i]; mi = i; }
    }
    void mi;
    pk += m;
    rest += s - m;
    nr += p.length - 1;
  }
  const n0 = rest / Math.max(1, nr);
  const es = Math.max(pk / Math.max(1, spectra.length) - n0, n0 * 1e-3);
  return { es, n0 };
}
