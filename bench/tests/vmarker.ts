import { Downconverter } from '../../src/dsp/decimator.ts';
import { fft, ifft, nextPow2 } from '../../src/dsp/fft.ts';
import { applyRamps } from '../../src/dsp/signal.ts';

/**
 * Long "V" sync marker for the candidate BER mode: an up-chirp then a down-chirp across the
 * occupied band, phase- and frequency-continuous at the top. A plain linear chirp's matched filter
 * converts a frequency offset δf into a timing error δf/k (k = chirp rate); for a 1 s chirp across
 * 1.3 kHz, 40 ppm of clock mismatch (0.7 Hz) moves the peak by 0.5 ms — most of a chip. In a V the
 * two halves move in opposite directions and the combined peak stays put.
 *
 * Detection averages the two halves' |ρ|² (each half has time–bandwidth ≈ 650, so the noise-only
 * mean is ≈ 1.5e-3 and the average is Gamma(2)-distributed): a 0.02 threshold gives a per-lag false
 * alarm of ≈ 27·e^{−27} ≈ 7e-11 (≈ 1e-5 per minute of recording) and detects down to ≈ −17 dB
 * in-band SNR, below where the slow uncoded candidates stop working.
 */
export interface VMarkerSpec {
  f0: number;
  f1: number;
  /** Total duration (up + down), seconds. */
  dur: number;
  ramp: number;
}

export const V_MARKER: VMarkerSpec = { f0: 17100, f1: 18400, dur: 1.0, ramp: 0.01 };
export const V_MARKER_THRESHOLD = 0.02;

export function vMarkerWave(fs: number, s: VMarkerSpec = V_MARKER): Float32Array {
  const n = Math.round(s.dur * fs);
  const y = new Float32Array(n);
  const half = s.dur / 2;
  const k = (s.f1 - s.f0) / half;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const f = t < half ? s.f0 + k * t : s.f1 - k * (t - half);
    y[i] = Math.cos(ph);
    ph += (2 * Math.PI * f) / fs;
  }
  applyRamps(y, fs, s.ramp);
  return y;
}

export interface VMarkerHit {
  time: number;
  score: number;
}

/** Normalised matched-filter output |ρ|² of baseband x against template t at every lag. */
function rhoOf(xr: number[], xi: number[], tr: number[], ti: number[]): Float64Array {
  let eT = 0;
  for (let i = 0; i < tr.length; i++) eT += tr[i] ** 2 + ti[i] ** 2;
  const n = xr.length;
  const N = nextPow2(n + tr.length);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(xr);
  ai.set(xi);
  br.set(tr);
  bi.set(ti);
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < N; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k];
    ai[k] = ai[k] * br[k] - ar[k] * bi[k];
    ar[k] = r;
  }
  ifft(ar, ai);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + xr[i] ** 2 + xi[i] ** 2;
  const L = tr.length;
  const rho = new Float64Array(Math.max(0, n - L + 1));
  for (let k = 0; k < rho.length; k++) {
    const e = cum[k + L] - cum[k];
    rho[k] = e > 0 ? (ar[k] ** 2 + ai[k] ** 2) / (eT * e) : 0;
  }
  return rho;
}

/** Parabolic-interpolated peak position of rho near index k (searching ±w). */
function peakNear(rho: Float64Array, k: number, w: number): number {
  let best = Math.max(0, Math.min(rho.length - 1, k));
  for (let j = Math.max(0, k - w); j <= Math.min(rho.length - 1, k + w); j++) if (rho[j] > rho[best]) best = j;
  const a = rho[best - 1] ?? rho[best], b = rho[best], c = rho[best + 1] ?? rho[best];
  const den = a - 2 * b + c;
  return best + (den === 0 ? 0 : (0.5 * (a - c)) / den);
}

/**
 * Detection on the mean of the two halves' |ρ|² (same lag); timing = mean of the up-half and
 * down-half peak positions, whose frequency-offset shifts are equal and opposite.
 */
export function findVMarkers(x: ArrayLike<number>, fs: number, s: VMarkerSpec = V_MARKER, threshold = V_MARKER_THRESHOLD): VMarkerHit[] {
  const h = (s.f1 - s.f0) / 2;
  const mk = () => new Downconverter({ fs, fCenter: (s.f0 + s.f1) / 2, passHalfHz: h, stopHalfHz: h + 100, minOversample: 2 });
  const bb = (sig: ArrayLike<number>) => {
    const d = mk();
    const re: number[] = [], im: number[] = [];
    d.process(sig, re, im);
    d.process(new Float32Array(Math.ceil(d.delay) + d.decim), re, im);
    return { re, im, d };
  };
  const X = bb(x);
  const T = bb(vMarkerWave(fs, s));
  const m = Math.round((s.dur * fs) / T.d.decim);
  const half = Math.round(m / 2);
  const off = Math.round(T.d.delay / T.d.decim);
  const up = rhoOf(X.re, X.im, T.re.slice(off, off + half), T.im.slice(off, off + half));
  const dn = rhoOf(X.re, X.im, T.re.slice(off + half, off + m), T.im.slice(off + half, off + m));
  const n = Math.max(0, Math.min(up.length, dn.length - half));
  const comb = new Float64Array(n);
  for (let k = 0; k < n; k++) comb[k] = (up[k] + dn[k + half]) / 2;
  // the half-peaks may sit apart by 2·δf/k; allow a few chips of search around the combined peak
  const w = Math.ceil((4 * fs) / X.d.decim / (2 * h));
  const hits: VMarkerHit[] = [];
  let k = 0;
  while (k < n) {
    if (comb[k] < threshold) {
      k++;
      continue;
    }
    let best = k;
    for (let j = k; j < Math.min(n, k + m); j++) if (comb[j] > comb[best]) best = j;
    const tu = peakNear(up, best, w);
    const td = peakNear(dn, best + half, w) - half;
    hits.push({ time: (((tu + td) / 2 - off) * X.d.decim) / fs, score: comb[best] });
    k = best + m;
  }
  return hits;
}
