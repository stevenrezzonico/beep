import { findMarkers, markerWave, DEFAULT_MARKER, type MarkerHit } from '../../src/dsp/marker.ts';
import { applyRamps } from '../../src/dsp/signal.ts';

/**
 * Shared plumbing for bench tests. Every test signal is a sequence of named segments whose start
 * times (seconds) are measured from the start of the sync marker; the TX side renders them at the
 * device's sample rate and the RX side, after locating the marker, reads the same segments back.
 * Times are in seconds so both devices agree even when one runs at 44.1 kHz and the other at 48.
 */

export interface Segment {
  name: string;
  /** Seconds from marker start. */
  start: number;
  dur: number;
  /** Tone/sweep parameters, if any. */
  freq?: number;
  f0?: number;
  f1?: number;
  levelDb?: number;
}

/** Silence after the marker before test content, long enough for the marker's echo to decay. */
export const POST_MARKER_GAP = 0.3;
/** Raised-cosine ramp on every tone: several ms keeps onsets click-free. */
export const TONE_RAMP = 0.01;

/** Sequential layout helper: pushes segments back to back with optional gaps. */
export class LayoutBuilder {
  t = DEFAULT_MARKER.dur + POST_MARKER_GAP;
  readonly segs: Segment[] = [{ name: 'marker', start: 0, dur: DEFAULT_MARKER.dur }];

  add(seg: Omit<Segment, 'start'>, gapAfter = 0): Segment {
    const s = { ...seg, start: this.t };
    this.segs.push(s);
    this.t += seg.dur + gapAfter;
    return s;
  }

  gap(sec: number): void {
    this.t += sec;
  }

  /** Total duration including a short tail so the last ramp/echo is recorded. */
  total(tail = 0.2): number {
    return this.t + tail;
  }
}

export function rampedTone(freq: number, dur: number, fs: number, amp = 1, ramp = TONE_RAMP): Float32Array {
  const n = Math.round(dur * fs);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.cos((2 * Math.PI * freq * i) / fs);
  applyRamps(y, fs, ramp);
  return y;
}

/** Linear sweep, ramped. */
export function rampedSweep(f0: number, f1: number, dur: number, fs: number, amp = 1, ramp = TONE_RAMP): Float32Array {
  const n = Math.round(dur * fs);
  const y = new Float32Array(n);
  const k = (f1 - f0) / dur;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    y[i] = amp * Math.cos(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  applyRamps(y, fs, ramp);
  return y;
}

/** Render segments into one buffer: marker at 0, each segment's wave at round(start·fs). */
export function render(
  fs: number,
  totalSec: number,
  segs: Segment[],
  wave: (s: Segment) => Float32Array | null,
): Float32Array {
  const y = new Float32Array(Math.ceil(totalSec * fs));
  y.set(markerWave(fs));
  for (const s of segs) {
    if (s.name === 'marker') continue;
    const w = wave(s);
    if (!w) continue;
    const o = Math.round(s.start * fs);
    for (let i = 0; i < w.length && o + i < y.length; i++) y[o + i] += w[i];
  }
  return y;
}

export class MarkerNotFound extends Error {
  constructor() {
    super('Sync marker not found — raise the TX volume, move the devices closer, or check the mic is not muted.');
    this.name = 'MarkerNotFound';
  }
}

/** First marker in the recording (the operator may have pressed Play more than once). */
export function locateMarker(rec: Float32Array, fs: number): MarkerHit & { count: number } {
  const hits = findMarkers(rec, fs);
  if (!hits.length) throw new MarkerNotFound();
  return { ...hits[0], count: hits.length };
}

/** Sample index range [a, b) of a segment after the marker, shrunk by `trim` seconds on each side. */
export function segRange(fs: number, t0: number, s: Segment, trim = 0, n = Infinity): [number, number] {
  const a = Math.max(0, Math.round((t0 + s.start + trim) * fs));
  const b = Math.min(n, Math.round((t0 + s.start + s.dur - trim) * fs));
  return [a, Math.max(a, b)];
}

/**
 * Amplitude of a sinusoid at f over x[start,end) with a Hann window, normalised so that
 * A·cos(2πft) reads A regardless of block length. Hann sidelobes (−31 dB, falling 18 dB/oct)
 * keep the neighbouring step tones' reverb tails out of the measurement.
 */
export function toneAmp(x: ArrayLike<number>, fs: number, f: number, start: number, end: number): number {
  const n = end - start;
  if (n < 2) return 0;
  const w = (2 * Math.PI * f) / fs;
  let re = 0;
  let im = 0;
  let ws = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const v = x[start + i] * h;
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
    ws += h;
  }
  return (2 * Math.hypot(re, im)) / ws;
}

/**
 * RMS of toneAmp over consecutive blocks of `blockSec`: the noise "amplitude" a tone measurement
 * of the same length would see at f. Comparing tone and noise with equal block lengths makes the
 * SNR per bin independent of the analysis bandwidth.
 */
export function noiseAmp(x: ArrayLike<number>, fs: number, f: number, start: number, end: number, blockSec: number): number {
  const L = Math.max(2, Math.round(blockSec * fs));
  let p = 0;
  let k = 0;
  for (let a = start; a + L <= end; a += L) {
    p += toneAmp(x, fs, f, a, a + L) ** 2;
    k++;
  }
  return k ? Math.sqrt(p / k) : NaN;
}

/** Tone level in dB per frame over [start, end). */
export function frameLevelsDb(x: ArrayLike<number>, fs: number, f: number, start: number, end: number, frameSec: number): number[] {
  const L = Math.max(2, Math.round(frameSec * fs));
  const out: number[] = [];
  for (let a = start; a + L <= end; a += L) out.push(ampDb(toneAmp(x, fs, f, a, a + L)));
  return out;
}

export function ampDb(a: number): number {
  return 20 * Math.log10(Math.max(a, 1e-12));
}

export function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

export function std(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** Ordinary least squares y = a + b·x. */
export function linfit(x: number[], y: number[]): { a: number; b: number; rms: number } {
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : NaN;
  const a = my - b * mx;
  let r = 0;
  for (let i = 0; i < n; i++) r += (y[i] - a - b * x[i]) ** 2;
  return { a, b, rms: Math.sqrt(r / Math.max(1, n)) };
}

/** Power subtraction: level of the signal alone given measured (signal+noise) and noise, dB. */
export function subtractNoiseDb(totalDb: number, noiseDb: number): number {
  const p = Math.pow(10, totalDb / 10) - Math.pow(10, noiseDb / 10);
  return p > 0 ? 10 * Math.log10(p) : -Infinity;
}

export type Verdict = 'yes' | 'no' | 'unknown';

export const round = (v: number, d = 2): number => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
