/**
 * Kaiser-window FIR design. Filters are specified in Hz (passband edge, stopband edge,
 * stopband attenuation) and converted to taps for whatever sample rate the device runs at,
 * so nothing here depends on 44.1 vs 48 kHz.
 */

/** Zeroth-order modified Bessel function of the first kind. */
export function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

/** Kaiser β for a given stopband attenuation in dB (Kaiser 1974). */
export function kaiserBeta(attenDb: number): number {
  if (attenDb > 50) return 0.1102 * (attenDb - 8.7);
  if (attenDb >= 21) return 0.5842 * Math.pow(attenDb - 21, 0.4) + 0.07886 * (attenDb - 21);
  return 0;
}

/** Number of taps (odd) for given attenuation and transition width (Hz) at sample rate fs. */
export function kaiserLength(attenDb: number, transitionHz: number, fs: number): number {
  const dw = (2 * Math.PI * transitionHz) / fs;
  let n = Math.ceil((attenDb - 8) / (2.285 * dw)) + 1;
  if (n % 2 === 0) n++;
  return Math.max(n, 3);
}

export function kaiserWindow(n: number, beta: number): Float64Array {
  const w = new Float64Array(n);
  const denom = besselI0(beta);
  const m = n - 1;
  for (let i = 0; i < n; i++) {
    const r = m === 0 ? 0 : (2 * i) / m - 1;
    w[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
  }
  return w;
}

export interface LowpassSpec {
  fs: number;
  passHz: number;
  stopHz: number;
  attenDb: number;
}

/** Linear-phase low-pass FIR with unity DC gain. Odd length, group delay (len-1)/2 samples. */
export function designLowpass(spec: LowpassSpec): Float64Array {
  const { fs, passHz, stopHz, attenDb } = spec;
  if (!(stopHz > passHz)) throw new Error('stopHz must exceed passHz');
  const n = kaiserLength(attenDb, stopHz - passHz, fs);
  const fc = (passHz + stopHz) / 2 / fs; // cycles/sample
  const w = kaiserWindow(n, kaiserBeta(attenDb));
  const h = new Float64Array(n);
  const mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    h[i] = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * w[i];
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

/** Frequency response magnitude of an FIR at frequency f (Hz). */
export function firResponse(h: Float64Array, f: number, fs: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * f) / fs;
  for (let i = 0; i < h.length; i++) {
    re += h[i] * Math.cos(w * i);
    im -= h[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im);
}
