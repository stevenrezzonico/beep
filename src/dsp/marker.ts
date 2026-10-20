import { Downconverter } from './decimator.ts';
import { fft, ifft, nextPow2 } from './fft.ts';
import { applyRamps } from './signal.ts';

/**
 * Bench sync marker: a ramped linear up-chirp across the occupied band. Each bench test starts
 * with one so the receiving device can find the test signal in its recording without any shared
 * clock. Detection is a matched filter on the complex baseband, normalised by local energy so
 * the decision does not depend on absolute level (no AGC needed).
 */
export interface MarkerSpec {
  f0: number;
  f1: number;
  /** Seconds. Time–bandwidth product (dur × (f1−f0)) is the matched-filter gain. */
  dur: number;
  /** Raised-cosine ramp at each end, seconds. */
  ramp: number;
}

export const DEFAULT_MARKER: MarkerSpec = { f0: 17100, f1: 18400, dur: 0.25, ramp: 0.01 };

export function markerWave(fs: number, spec: MarkerSpec = DEFAULT_MARKER, amp = 1): Float32Array {
  const n = Math.round(spec.dur * fs);
  const y = new Float32Array(n);
  const k = (spec.f1 - spec.f0) / spec.dur;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    y[i] = amp * Math.cos(2 * Math.PI * (spec.f0 * t + 0.5 * k * t * t));
  }
  applyRamps(y, fs, spec.ramp);
  return y;
}

export interface MarkerHit {
  /** Start time of the marker in the recording, seconds. */
  time: number;
  /** Normalised correlation |ρ|² in [0,1]. */
  score: number;
}

/**
 * Find markers in a recording. `threshold` is on |ρ|²: for white noise |ρ|² has mean ≈
 * 1/(dur·bw) (≈0.003 for the default marker), so 0.1 is >30× the noise mean, giving a per-lag
 * false-alarm probability of roughly e^{-0.1·dur·bw} ≈ 1e-14, while still triggering at an
 * in-band SNR of about −10 dB.
 */
export function findMarkers(
  x: ArrayLike<number>,
  fs: number,
  spec: MarkerSpec = DEFAULT_MARKER,
  threshold = 0.1,
): MarkerHit[] {
  const half = (spec.f1 - spec.f0) / 2;
  const mk = () =>
    new Downconverter({ fs, fCenter: (spec.f0 + spec.f1) / 2, passHalfHz: half, stopHalfHz: half + 100, minOversample: 2 });
  const dx = mk();
  const xr: number[] = [];
  const xi: number[] = [];
  dx.process(x, xr, xi);
  dx.process(new Float32Array(Math.ceil(dx.delay) + dx.decim), xr, xi);
  const dt = mk();
  const tr: number[] = [];
  const ti: number[] = [];
  const tpl = markerWave(fs, spec);
  dt.process(tpl, tr, ti);
  dt.process(new Float32Array(Math.ceil(dt.delay) + dt.decim), tr, ti);
  // trim template to its occupied span
  const m = Math.round((spec.dur * fs) / dt.decim);
  const off = Math.round(dt.delay / dt.decim);
  const Tr = tr.slice(off, off + m);
  const Ti = ti.slice(off, off + m);
  let eT = 0;
  for (let i = 0; i < Tr.length; i++) eT += Tr[i] ** 2 + Ti[i] ** 2;

  const n = xr.length;
  const N = nextPow2(n + Tr.length);
  const ar = new Float64Array(N), ai = new Float64Array(N);
  const br = new Float64Array(N), bi = new Float64Array(N);
  for (let i = 0; i < n; i++) { ar[i] = xr[i]; ai[i] = xi[i]; }
  for (let i = 0; i < Tr.length; i++) { br[i] = Tr[i]; bi[i] = Ti[i]; }
  fft(ar, ai);
  fft(br, bi);
  // cross-correlation: X · conj(T)
  for (let k = 0; k < N; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k];
    const im = ai[k] * br[k] - ar[k] * bi[k];
    ar[k] = r;
    ai[k] = im;
  }
  ifft(ar, ai);
  // sliding energy of x over template length
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + xr[i] ** 2 + xi[i] ** 2;
  const L = Tr.length;
  const rho = new Float64Array(Math.max(0, n - L + 1));
  for (let k = 0; k < rho.length; k++) {
    const e = cum[k + L] - cum[k];
    rho[k] = e > 0 ? (ar[k] ** 2 + ai[k] ** 2) / (eT * e) : 0;
  }
  const hits: MarkerHit[] = [];
  const minGap = Math.round(L);
  let k = 0;
  while (k < rho.length) {
    if (rho[k] < threshold) { k++; continue; }
    // take the maximum within the next marker length
    let best = k;
    for (let j = k; j < Math.min(rho.length, k + minGap); j++) if (rho[j] > rho[best]) best = j;
    const a = rho[best - 1] ?? rho[best], b = rho[best], c = rho[best + 1] ?? rho[best];
    const den = a - 2 * b + c;
    const d = den === 0 ? 0 : (0.5 * (a - c)) / den;
    hits.push({ time: ((best + d - off) * dx.decim) / fs, score: b });
    k = best + minGap;
  }
  return hits;
}
