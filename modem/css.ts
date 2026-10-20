import { fft } from '../src/dsp/fft.ts';

/**
 * Chirp spread spectrum (LoRa-style) symbol synthesis and demodulation.
 *
 * A symbol of spreading factor SF is an up-chirp sweeping the occupied band [f0, f1]
 * (BW = f1 − f0) in Ts = 2^SF / BW seconds, cyclically shifted by s/2^SF of a period. Data is the
 * shift s. Demodulation multiplies the complex baseband (sampled at the chip rate BW) by the
 * conjugate base chirp, which turns the symbol into a single tone at FFT bin s.
 *
 * The waveform has a constant envelope and continuous phase everywhere (including symbol
 * boundaries and the in-symbol frequency wrap), and only one frequency is present at any instant,
 * so the speaker sees nothing that can intermodulate into the audible range.
 */

export type ChirpKind = 'up' | 'down';

export interface CssSymbol {
  kind: ChirpKind;
  /** Cyclic shift in chips (0 ≤ value < 2^SF) — only for up-chirps. */
  value: number;
  /** Fraction of a full symbol to emit (1 normally; 0.25 for the LoRa-style quarter down-chirp). */
  frac?: number;
}

export interface CssParams {
  f0: number;
  bw: number;
  sf: number;
}

export function symbolTime(p: { bw: number; sf: number }): number {
  return (1 << p.sf) / p.bw;
}

/** Instantaneous passband frequency τ seconds into a symbol. */
export function symbolFrequency(p: CssParams, sym: CssSymbol, tau: number): number {
  const Ts = symbolTime(p);
  if (sym.kind === 'down') return p.f0 + p.bw - (p.bw * tau) / Ts;
  const u = tau / Ts + sym.value / (1 << p.sf);
  return p.f0 + p.bw * (u - Math.floor(u));
}

/**
 * Write the instantaneous-frequency trajectory of a symbol sequence starting at tStart (s) into
 * `freq` (one value per sample at rate fs). Samples outside the sequence are left untouched.
 * Returns the end time. Render with `renderFrequency` (src/dsp/signal.ts).
 */
export function symbolsTrajectory(p: CssParams, syms: CssSymbol[], fs: number, freq: Float64Array, tStart: number): number {
  const Ts = symbolTime(p);
  let t = tStart;
  for (const s of syms) {
    const dur = Ts * (s.frac ?? 1);
    const i0 = Math.max(0, Math.ceil(t * fs - 1e-9));
    const i1 = Math.min(freq.length, Math.ceil((t + dur) * fs - 1e-9));
    for (let i = i0; i < i1; i++) freq[i] = symbolFrequency(p, s, i / fs - t);
    t += dur;
  }
  return t;
}

export function symbolsDuration(p: { bw: number; sf: number }, syms: CssSymbol[]): number {
  const Ts = symbolTime(p);
  return syms.reduce((a, s) => a + Ts * (s.frac ?? 1), 0);
}

/** Base up-chirp at chip rate (baseband, centred): c[k] = exp(j2π(k²/2N − k/2)). */
const baseCache = new Map<number, { re: Float64Array; im: Float64Array }>();
export function baseChirp(sf: number): { re: Float64Array; im: Float64Array } {
  let c = baseCache.get(sf);
  if (c) return c;
  const N = 1 << sf;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    // reduce the phase modulo 1 cycle in exact arithmetic to keep precision at large N
    const num = (k * k - k * N) % (2 * N); // (k² − kN) / 2N cycles
    const ph = (Math.PI * num) / N;
    re[k] = Math.cos(ph);
    im[k] = Math.sin(ph);
  }
  c = { re, im };
  baseCache.set(sf, c);
  return c;
}

/**
 * Dechirp N chip-rate baseband samples and FFT. `kind` is the chirp expected in the window
 * ('up' → multiply by conj(base); 'down' → multiply by base). `cfoBins` is removed first
 * (de-rotation by −cfoBins/N cycles per chip). Result is written into re/im (power spectrum
 * left to the caller).
 */
export function dechirpFft(
  zRe: ArrayLike<number>,
  zIm: ArrayLike<number>,
  sf: number,
  kind: ChirpKind,
  re: Float64Array,
  im: Float64Array,
  cfoBins = 0,
): void {
  const N = 1 << sf;
  const c = baseChirp(sf);
  const sgn = kind === 'up' ? -1 : 1;
  for (let k = 0; k < N; k++) {
    let a = zRe[k];
    let b = zIm[k];
    if (cfoBins !== 0) {
      const ph = (-2 * Math.PI * cfoBins * k) / N;
      const cr = Math.cos(ph), ci = Math.sin(ph);
      const t = a * cr - b * ci;
      b = a * ci + b * cr;
      a = t;
    }
    const cr = c.re[k];
    const ci = sgn * c.im[k];
    re[k] = a * cr - b * ci;
    im[k] = a * ci + b * cr;
  }
  fft(re, im);
}
