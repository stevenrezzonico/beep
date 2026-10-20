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

/**
 * Render a constant-envelope waveform from an instantaneous-frequency trajectory (Hz per
 * sample). The trajectory is first smoothed with a normalised Hann kernel of `smoothSec`
 * (GFSK-style), which turns every frequency step into a short glide: linear chirp segments are
 * unchanged (a symmetric kernel preserves straight lines) and only ±smoothSec/2 around each step
 * is altered, but the spectral skirt of the step falls off far faster, keeping energy out of the
 * audible range. Phase is integrated with the trapezoid rule, exact for linear segments.
 */
export function renderFrequency(freq: Float64Array, fs: number, smoothSec: number, amp = 1, phase0 = 0): Float32Array {
  let f = freq;
  const half = Math.floor((smoothSec * fs) / 2);
  if (half >= 1) {
    const L = 2 * half + 1;
    const k = new Float64Array(L);
    let s = 0;
    for (let i = 0; i < L; i++) s += k[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (L + 1));
    for (let i = 0; i < L; i++) k[i] /= s;
    f = new Float64Array(freq.length);
    for (let i = 0; i < freq.length; i++) {
      let acc = 0;
      for (let j = -half; j <= half; j++) {
        const idx = Math.min(freq.length - 1, Math.max(0, i + j)); // hold the edge value
        acc += k[j + half] * freq[idx];
      }
      f[i] = acc;
    }
  }
  const y = new Float32Array(f.length);
  let ph = phase0;
  for (let i = 0; i < f.length; i++) {
    if (i > 0) ph += (Math.PI * (f[i - 1] + f[i])) / fs;
    if (ph > 1e6) ph %= 2 * Math.PI;
    y[i] = amp * Math.cos(ph);
  }
  return y;
}
