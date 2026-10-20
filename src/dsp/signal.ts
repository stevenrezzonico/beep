/** Small signal utilities shared by modem, bench and simulator. All time parameters in seconds. */

export function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

export function linToDb(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

export function powToDb(p: number): number {
  return 10 * Math.log10(Math.max(p, 1e-24));
}

export function rms(x: ArrayLike<number>, start = 0, end = x.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function peakAbs(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

/**
 * Raised-cosine (Hann) fade of `rampSec` at both ends, in place. Ramps keep onsets/offsets
 * free of broadband clicks.
 */
export function applyRamps(x: Float32Array, fs: number, rampSec: number): void {
  const n = Math.min(Math.floor(x.length / 2), Math.round(rampSec * fs));
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / n);
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
}

/** Phase-continuous tone generator: frequencies in Hz per sample, returns cos(phase). */
export function tone(freqHz: number, durSec: number, fs: number, amp = 1, phase0 = 0): Float32Array {
  const n = Math.round(durSec * fs);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.cos(phase0 + (2 * Math.PI * freqHz * i) / fs);
  return y;
}

/** Linear sweep f0→f1 over durSec (constant envelope, continuous phase). */
export function sweep(f0: number, f1: number, durSec: number, fs: number, amp = 1): Float32Array {
  const n = Math.round(durSec * fs);
  const y = new Float32Array(n);
  const k = (f1 - f0) / durSec;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    y[i] = amp * Math.cos(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return y;
}

export function concat(parts: Float32Array[]): Float32Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const y = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    y.set(p, o);
    o += p.length;
  }
  return y;
}

export function silence(durSec: number, fs: number): Float32Array {
  return new Float32Array(Math.round(durSec * fs));
}
