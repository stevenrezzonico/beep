import { fft, nextPow2 } from './fft.ts';

/** Window functions and level-per-frequency measurement used by the bench. */

export function blackmanHarris(n: number): Float64Array {
  const w = new Float64Array(n);
  const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
  }
  return w;
}

export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export interface Spectrum {
  /** Bin centre frequencies, Hz. */
  freqs: Float64Array;
  /** Power per bin, dBFS (a full-scale sine reads 0 dBFS at its bin). */
  db: Float64Array;
  binHz: number;
  /** Equivalent noise bandwidth of one bin, Hz (to convert bin power to density). */
  enbwHz: number;
}

/**
 * Averaged (Welch) power spectrum with a Blackman–Harris window, normalised so a full-scale
 * sine reads 0 dBFS. `size` is rounded up to a power of two.
 */
export function welch(x: ArrayLike<number>, fs: number, size = 4096, overlap = 0.5): Spectrum {
  const n = nextPow2(size);
  const w = blackmanHarris(n);
  let wsum = 0;
  let w2 = 0;
  for (let i = 0; i < n; i++) {
    wsum += w[i];
    w2 += w[i] * w[i];
  }
  const hop = Math.max(1, Math.floor(n * (1 - overlap)));
  const acc = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let frames = 0;
  for (let start = 0; start + n <= x.length; start += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  // full-scale sine amplitude 1 → |X| = wsum/2 at its bin
  const ref = (wsum / 2) ** 2;
  const freqs = new Float64Array(n / 2 + 1);
  const db = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    freqs[k] = (k * fs) / n;
    db[k] = 10 * Math.log10(Math.max(acc[k] / Math.max(1, frames) / ref, 1e-20));
  }
  const binHz = fs / n;
  return { freqs, db, binHz, enbwHz: (binHz * n * w2) / (wsum * wsum) };
}

/** Sum of power over [f0, f1] in a Spectrum, in dBFS (energy in band, window-ENBW corrected). */
export function bandPowerDb(s: Spectrum, f0: number, f1: number): number {
  let p = 0;
  for (let k = 0; k < s.freqs.length; k++) {
    if (s.freqs[k] >= f0 && s.freqs[k] <= f1) p += Math.pow(10, s.db[k] / 10);
  }
  // each bin of a sine shows its full power once; noise spreads by enbw/binHz
  return 10 * Math.log10(Math.max((p * s.binHz) / s.enbwHz, 1e-20));
}

/**
 * Peak level (dBFS) and frequency within [f0, f1]. The level sums power over the window's main
 * lobe (±4 bins for Blackman–Harris), so it is free of scalloping loss for off-bin tones.
 */
export function peakIn(s: Spectrum, f0: number, f1: number): { db: number; freq: number } {
  let best = -Infinity;
  let kb = -1;
  for (let k = 1; k < s.freqs.length - 1; k++) {
    if (s.freqs[k] < f0 || s.freqs[k] > f1) continue;
    if (s.db[k] > best) {
      best = s.db[k];
      kb = k;
    }
  }
  if (kb < 0) return { db: -Infinity, freq: 0 };
  let p = 0;
  let pf = 0;
  for (let k = Math.max(0, kb - 4); k <= Math.min(s.freqs.length - 1, kb + 4); k++) {
    const v = Math.pow(10, s.db[k] / 10);
    p += v;
    pf += v * s.freqs[k];
  }
  return { db: 10 * Math.log10((p * s.binHz) / s.enbwHz), freq: pf / p };
}

/** Single-frequency amplitude by Goertzel over a block (returns amplitude relative to full scale). */
export function goertzelAmp(x: ArrayLike<number>, fs: number, f: number, start = 0, end = x.length): number {
  const n = end - start;
  const w = (2 * Math.PI * f) / fs;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = start; i < end; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return (2 * Math.hypot(re, im)) / n;
}
