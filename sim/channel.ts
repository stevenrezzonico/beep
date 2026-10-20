import { Rng } from '../src/dsp/prng.ts';
import { designLowpass } from '../src/dsp/kaiser.ts';
import { besselI0 } from '../src/dsp/kaiser.ts';
import { fft, ifft, nextPow2 } from '../src/dsp/fft.ts';

/**
 * Acoustic channel model for the headless simulator. Order of operations mirrors the physical
 * path: speaker (nonlinearity + band-limit) → room (impulse response) → motion / clock
 * (time-varying resampling, which yields Doppler and drift together) → microphone (tilt) →
 * additive noise at the receiver's sample rate.
 *
 * SNR convention (used everywhere in this repo): `snrDb` is the ratio of the power of a
 * full-peak sine (A²/2 for transmit peak A, after the direct-path gain) to the noise power inside
 * the 1.5 kHz allowed band [fLow, fHigh]. Referencing the transmit *peak* rather than each
 * waveform's average power charges every modulation for its peak-to-average ratio, because a
 * phone speaker is peak-limited: OOK or OFDM must back off and lose that much range.
 */
export interface ChannelOptions {
  fsTx: number;
  fsRx: number;
  /** Peak-referenced in-band SNR (see above). Infinity disables noise. */
  snrDb: number;
  /** Transmit peak amplitude the SNR refers to (default: measured peak of the input). */
  txPeak?: number;
  /** Reference noise band for the SNR, Hz. */
  noiseBand?: [number, number];
  /** Room impulse response at fsTx (direct path normalised to gain 1). */
  ir?: Float32Array;
  /** Constant radial velocity, m/s (positive = approaching → frequencies go up). */
  velocity?: number;
  /** Sinusoidal motion: peak velocity (m/s) and period (s), added to `velocity`. */
  motion?: { peakVel: number; period: number };
  /** Receiver clock error relative to transmitter, ppm. */
  clockPpm?: number;
  /** Cubic speaker nonlinearity coefficient: y = x − k3·x³ (on the peak-normalised signal). */
  speakerK3?: number;
  /** Response tilt across the band, dB at fHigh relative to fLow (speaker+mic roll-off). */
  tiltDb?: number;
  /** Leading silence at the receiver, seconds (random timing offset is drawn by the caller). */
  leadSec?: number;
  /** Trailing silence, seconds. */
  tailSec?: number;
  /** Narrow-band interferer (e.g. a monitor whine) at the given frequency and level (dB re. ref sine). */
  interferer?: { freq: number; relDb: number };
  /** Impulsive noise: clicks per second and level (dB re. ref sine peak). */
  clicks?: { rate: number; relDb: number };
  seed?: number;
}

const SOUND_SPEED = 343;

/** Windowed-sinc kernel for arbitrary-ratio resampling (signals here are band-limited < 19 kHz). */
const RS_HALF = 16;
const RS_RES = 256;
const RS_BETA = 9;
const rsTable = (() => {
  const t = new Float64Array(2 * RS_HALF * RS_RES + 2);
  const d = besselI0(RS_BETA);
  for (let i = 0; i < t.length; i++) {
    const x = i / RS_RES - RS_HALF;
    const r = x / RS_HALF;
    const w = Math.abs(r) <= 1 ? besselI0(RS_BETA * Math.sqrt(1 - r * r)) / d : 0;
    t[i] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
  }
  return t;
})();

function rsKernel(x: number): number {
  const p = (x + RS_HALF) * RS_RES;
  const i = Math.floor(p);
  if (i < 0 || i >= rsTable.length - 1) return 0;
  const f = p - i;
  return rsTable[i] * (1 - f) + rsTable[i + 1] * f;
}

/** Sample x (rate fs) at fractional input index t. */
function sampleAt(x: Float32Array, t: number): number {
  const i0 = Math.floor(t);
  const f = t - i0;
  let s = 0;
  for (let i = Math.max(0, i0 - RS_HALF + 1); i <= Math.min(x.length - 1, i0 + RS_HALF); i++) s += x[i] * rsKernel(i - i0 - f);
  return s;
}

/** FFT convolution. */
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
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = ar[i];
  return y;
}

/** Linear spectral tilt (dB across [fA,fB], flat outside) applied by FFT filtering. */
function applyTilt(x: Float32Array, fs: number, tiltDb: number, fA: number, fB: number): Float32Array {
  const N = nextPow2(x.length);
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(x);
  fft(re, im);
  for (let k = 0; k <= N / 2; k++) {
    const f = (k * fs) / N;
    const db = f <= fA ? 0 : f >= fB ? tiltDb : (tiltDb * (f - fA)) / (fB - fA);
    const g = Math.pow(10, db / 20);
    re[k] *= g; im[k] *= g;
    if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
  }
  ifft(re, im);
  return Float32Array.from(re.subarray(0, x.length));
}

/**
 * Speaker model: memoryless cubic compression evaluated at 4× oversampling (so harmonics do not
 * alias back into the simulation band), then a 20 kHz low-pass for the transducer roll-off.
 */
function speaker(x: Float32Array, fs: number, k3: number, peak: number): Float32Array {
  const os = 4;
  const fsu = fs * os;
  const h = designLowpass({ fs: fsu, passHz: 20000, stopHz: fs / 2, attenDb: 70 });
  const half = (h.length - 1) / 2;
  // upsample by zero-stuffing + filter
  const up = new Float32Array(x.length * os);
  for (let i = 0; i < x.length; i++) up[i * os] = x[i] * os;
  const u = convolve(up, Float32Array.from(h)).subarray(half, half + up.length);
  for (let i = 0; i < u.length; i++) {
    const v = u[i] / peak;
    u[i] = peak * (v - k3 * v * v * v);
  }
  const d = convolve(Float32Array.from(u), Float32Array.from(h)).subarray(half, half + u.length);
  const y = new Float32Array(x.length);
  for (let i = 0; i < y.length; i++) y[i] = d[i * os];
  return y;
}

export interface ChannelResult {
  y: Float32Array;
  /** Time (s, receiver clock) at which the first transmitted sample's direct path arrives. */
  t0: number;
  /** Noise standard deviation actually used. */
  sigma: number;
}

export function applyChannel(x: Float32Array, o: ChannelOptions): ChannelResult {
  const rng = new Rng(o.seed ?? 1);
  const band = o.noiseBand ?? [17000, 18500];
  const peak = o.txPeak ?? x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  let s = x;
  if (o.speakerK3) s = speaker(s, o.fsTx, o.speakerK3, peak || 1);
  if (o.ir) s = convolve(s, o.ir);
  // time-varying resampling: receiver sample j at receiver time τ = j/fsRx corresponds to
  // transmitter time t(τ) with dt/dτ = (1 + v(τ)/c)·(1 + ppm·1e-6)… (rx clock fast ⇒ fewer tx s per rx s)
  const lead = o.leadSec ?? 0;
  const tail = o.tailSec ?? 0;
  const v0 = o.velocity ?? 0;
  const clk = 1 / (1 + (o.clockPpm ?? 0) * 1e-6);
  const durTx = s.length / o.fsTx;
  const nOut = Math.ceil((lead + durTx * 1.01 + tail) * o.fsRx);
  const y = new Float32Array(nOut);
  let tTx = 0;
  const dtau = 1 / o.fsRx;
  const leadN = Math.round(lead * o.fsRx);
  for (let j = leadN; j < nOut; j++) {
    const tau = (j - leadN) * dtau;
    let v = v0;
    if (o.motion) v += o.motion.peakVel * Math.sin((2 * Math.PI * tau) / o.motion.period);
    const idx = tTx * o.fsTx;
    if (idx >= s.length + RS_HALF) break;
    y[j] = sampleAt(s, idx);
    tTx += dtau * (1 + v / SOUND_SPEED) * clk;
  }
  let out: Float32Array = y;
  if (o.tiltDb) out = applyTilt(out, o.fsRx, o.tiltDb, band[0], band[1]);
  // noise: white, scaled so the power inside `band` equals refPower / SNR
  const refPower = (peak * peak) / 2;
  let sigma = 0;
  if (Number.isFinite(o.snrDb)) {
    const inBand = refPower / Math.pow(10, o.snrDb / 10);
    sigma = Math.sqrt((inBand * (o.fsRx / 2)) / (band[1] - band[0]));
    for (let i = 0; i < out.length; i++) out[i] += sigma * rng.gauss();
  }
  if (o.interferer) {
    const a = peak * Math.pow(10, o.interferer.relDb / 20);
    const ph = rng.next() * 2 * Math.PI;
    for (let i = 0; i < out.length; i++) out[i] += a * Math.cos(ph + (2 * Math.PI * o.interferer.freq * i) / o.fsRx);
  }
  if (o.clicks) {
    const a = peak * Math.pow(10, o.clicks.relDb / 20);
    const n = Math.round((o.clicks.rate * out.length) / o.fsRx);
    for (let c = 0; c < n; c++) {
      const at = rng.int(out.length);
      // a short decaying broadband transient
      for (let i = 0; i < Math.min(200, out.length - at); i++) out[at + i] += a * rng.gauss() * Math.exp(-i / 30);
    }
  }
  return { y: out, t0: lead, sigma };
}

export interface SyntheticIrOptions {
  fs: number;
  /** Reverberation time (−60 dB), seconds. */
  rt60: number;
  /** Direct-to-reverberant energy ratio, dB. */
  drrDb: number;
  /** Delay from direct path to start of the diffuse tail, seconds. */
  predelay?: number;
  /** Number of discrete early reflections. */
  early?: number;
  seed?: number;
}

/**
 * Synthetic room impulse response: unit direct path, a few early reflections, and an
 * exponentially decaying Gaussian tail with the requested RT60, scaled to the requested DRR.
 * Used until measured IRs from the bench are available (sim/ir/*.json).
 */
export function syntheticIr(o: SyntheticIrOptions): Float32Array {
  const rng = new Rng(o.seed ?? 7);
  const pre = o.predelay ?? 0.003;
  const len = Math.ceil((o.rt60 * 1.2 + pre) * o.fs);
  const h = new Float32Array(len);
  const tailStart = Math.round(pre * o.fs);
  const decay = (3 * Math.log(10)) / o.rt60; // amplitude e-folding so energy hits −60 dB at rt60
  let e = 0;
  for (let i = tailStart; i < len; i++) {
    const t = (i - tailStart) / o.fs;
    h[i] = rng.gauss() * Math.exp(-decay * t);
  }
  const nEarly = o.early ?? 4;
  for (let k = 0; k < nEarly; k++) {
    const i = tailStart + Math.round(rng.next() * 0.02 * o.fs);
    h[i] += (rng.next() < 0.5 ? -1 : 1) * (0.3 + 0.4 * rng.next());
  }
  for (let i = tailStart; i < len; i++) e += h[i] * h[i];
  const want = Math.pow(10, -o.drrDb / 10); // reverberant energy relative to direct (=1)
  const g = Math.sqrt(want / e);
  for (let i = tailStart; i < len; i++) h[i] *= g;
  h[0] = 1;
  return h;
}

/** Load a bench-measured IR ({fs, ir}) and resample to fs, normalising the direct-path peak to 1. */
export function prepareMeasuredIr(m: { fs: number; ir: number[] }, fs: number): Float32Array {
  const src = Float32Array.from(m.ir);
  const n = Math.round((src.length * fs) / m.fs);
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) out[j] = sampleAt(src, (j * m.fs) / fs);
  let pk = 0, at = 0;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > pk) { pk = Math.abs(out[i]); at = i; }
  const sh = out.subarray(Math.max(0, at - 32));
  const y = new Float32Array(sh.length);
  for (let i = 0; i < sh.length; i++) y[i] = sh[i] / pk;
  return y;
}
