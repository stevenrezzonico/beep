import { fft, ifft, nextPow2 } from '../../src/dsp/fft.ts';
import { designLowpass } from '../../src/dsp/kaiser.ts';
import { Rng } from '../../src/dsp/prng.ts';

/**
 * Minimal acoustic channel used only by the bench's Node tests, to check that the analyzers
 * recover known parameters (the full channel model lives in sim/).
 */
export interface TestChannel {
  gainDb?: number;
  /** Seconds of silence before the signal (operator delay). */
  delaySec?: number;
  /** Extra seconds appended after. */
  tailSec?: number;
  /** White noise RMS amplitude (full scale = 1). */
  noiseRms?: number;
  /** Exponential reverb: RT60 seconds and direct-to-reverberant ratio dB. */
  rt60?: number;
  drrDb?: number;
  /** Emulated voice-processing low-pass corner, Hz. */
  lowpassHz?: number;
  /** Emulated AGC: target RMS (dBFS) and time constant, s. */
  agc?: { targetDb: number; tau: number };
  seed?: number;
}

export function convolve(x: Float32Array, h: Float32Array): Float32Array {
  const n = x.length + h.length - 1;
  const N = nextPow2(n);
  const ar = new Float64Array(N), ai = new Float64Array(N);
  const br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(x);
  br.set(h);
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < N; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k];
    ai[k] = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
  }
  ifft(ar, ai);
  const y = new Float32Array(x.length);
  for (let i = 0; i < y.length; i++) y[i] = ar[i];
  return y;
}

/** Direct path (1 at t=0) plus exponentially decaying Gaussian tail with the given DRR. */
export function syntheticIr(fs: number, rt60: number, drrDb: number, rng: Rng): Float32Array {
  const n = Math.round(rt60 * 1.2 * fs);
  const h = new Float32Array(n);
  const decay = Math.log(1000) / rt60; // amplitude e-folding: −60 dB at rt60
  const start = Math.round(0.002 * fs); // first reflection after 2 ms
  let e = 0;
  for (let i = start; i < n; i++) {
    h[i] = rng.gauss() * Math.exp((-decay * i) / fs);
    e += h[i] * h[i];
  }
  const want = Math.pow(10, -drrDb / 10);
  const s = Math.sqrt(want / e);
  for (let i = start; i < n; i++) h[i] *= s;
  h[0] = 1;
  return h;
}

export function applyChannel(x: Float32Array, fs: number, c: TestChannel): Float32Array {
  const rng = new Rng(c.seed ?? 1);
  let y: Float32Array = x;
  if (c.rt60) y = convolve(y, syntheticIr(fs, c.rt60, c.drrDb ?? 0, rng));
  const g = Math.pow(10, (c.gainDb ?? 0) / 20);
  const pre = Math.round((c.delaySec ?? 0) * fs);
  const post = Math.round((c.tailSec ?? 0.5) * fs);
  const out = new Float32Array(pre + y.length + post);
  for (let i = 0; i < y.length; i++) out[pre + i] = g * y[i];
  if (c.noiseRms) for (let i = 0; i < out.length; i++) out[i] += c.noiseRms * rng.gauss();
  let z: Float32Array = out;
  if (c.lowpassHz) {
    const h = designLowpass({ fs, passHz: c.lowpassHz, stopHz: c.lowpassHz * 1.15, attenDb: 80 });
    const f = convolve(out, Float32Array.from(h));
    // compensate the linear-phase delay
    const d = (h.length - 1) / 2;
    z = new Float32Array(out.length);
    for (let i = 0; i < z.length; i++) z[i] = f[i + d] ?? 0;
  }
  if (c.agc) {
    // feed-back AGC on a one-pole power estimate, like a phone's voice AGC
    const target = Math.pow(10, c.agc.targetDb / 20);
    const a = 1 - Math.exp(-1 / (c.agc.tau * fs));
    let p = target * target;
    for (let i = 0; i < z.length; i++) {
      const gain = target / Math.sqrt(Math.max(p, 1e-10));
      const v = z[i] * Math.min(gain, 1000);
      p += a * (z[i] * z[i] - p);
      z[i] = v;
    }
  }
  return z;
}
