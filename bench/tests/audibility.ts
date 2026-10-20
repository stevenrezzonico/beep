import { welch, bandPowerDb, peakIn, type Spectrum } from '../../src/dsp/spectrum.ts';
import { markerWave } from '../../src/dsp/marker.ts';
import { applyRamps } from '../../src/dsp/signal.ts';
import { Rng } from '../../src/dsp/prng.ts';
import { DEFAULT_BAND } from '../../modem/band.ts';
import { findMarkers } from '../../src/dsp/marker.ts';
import { round } from './common.ts';

/**
 * Audibility A/B. The same symbol stream (random tone hops across the occupied band, one tone at
 * a time) is rendered two ways:
 *   A — continuous phase across symbol boundaries and raised-cosine ramps at start/stop,
 *   A2 — as A, plus raised-cosine smoothing of the frequency trajectory at symbol boundaries
 *        (GFSK-like): phase continuity alone still leaves a kink in phase slope at each hop,
 *   B — phase reset at every symbol, hard gating with short silent gaps, no ramps.
 * B's discontinuities splatter energy down into the audible range (clicks); A should keep
 * everything above 17 kHz. A third case plays two tones at once to expose speaker
 * intermodulation (17.0 + 18.0 kHz → 1 kHz difference tone), which the computed spectrum cannot
 * show — only a recording of the real speaker can.
 */
export type AudibilityCase = 'A' | 'A2' | 'B' | 'imd' | 'ref';

export interface AudibilityOptions {
  durSec: number;
  /** Symbol length for the hop stream; 25 ms is in the range of the faster modem profiles. */
  symbolSec: number;
  /** Ramp for case A; several ms per the brief. */
  rampSec: number;
  /** Silent gap B leaves between symbols (hard-gated). */
  gapSec: number;
  /** A2: length of the raised-cosine frequency transition, as a fraction of the symbol. */
  smoothFrac: number;
  imdF1: number;
  imdF2: number;
  refFreq: number;
  seed: number;
}

export const AUDIBILITY_DEFAULTS: AudibilityOptions = {
  durSec: 3,
  symbolSec: 0.025,
  rampSec: 0.01,
  gapSec: 0.003,
  smoothFrac: 0.3,
  imdF1: 17000,
  imdF2: 18000,
  refFreq: 17750,
  seed: 7,
};

function hops(o: AudibilityOptions): number[] {
  const rng = new Rng(o.seed);
  const f0 = DEFAULT_BAND.fLow + DEFAULT_BAND.guard;
  const f1 = DEFAULT_BAND.fHigh - DEFAULT_BAND.guard;
  const n = Math.round(o.durSec / o.symbolSec);
  // 1/T-spaced grid like an orthogonal MFSK alphabet
  const step = 1 / o.symbolSec;
  const m = Math.floor((f1 - f0) / step) + 1;
  return Array.from({ length: n }, () => f0 + rng.int(m) * step);
}

export function audibilitySignal(fs: number, c: AudibilityCase, o: AudibilityOptions = AUDIBILITY_DEFAULTS): Float32Array {
  const n = Math.round(o.durSec * fs);
  const y = new Float32Array(n);
  if (c === 'A' || c === 'A2' || c === 'B') {
    const f = hops(o);
    const ns = o.symbolSec * fs;
    const tw = o.smoothFrac * ns; // transition length, samples, centred on the boundary
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.min(f.length - 1, Math.floor(i / ns));
      if (c === 'A2') {
        // distance to the nearest boundary decides how far we are into the crossfade of frequency
        const pos = i - k * ns;
        let fi = f[k];
        if (pos < tw / 2 && k > 0) {
          const u = 0.5 + pos / tw; // 0.5..1 after the boundary
          fi = f[k - 1] + (f[k] - f[k - 1]) * (0.5 - 0.5 * Math.cos(Math.PI * u));
        } else if (ns - pos < tw / 2 && k + 1 < f.length) {
          const u = 0.5 - (ns - pos) / tw; // 0..0.5 before the boundary
          fi = f[k] + (f[k + 1] - f[k]) * (0.5 - 0.5 * Math.cos(Math.PI * u));
        }
        phase += (2 * Math.PI * fi) / fs;
        y[i] = Math.cos(phase);
      } else if (c === 'A') {
        phase += (2 * Math.PI * f[k]) / fs;
        y[i] = Math.cos(phase);
      } else {
        const local = i - Math.round(k * ns);
        y[i] = local < o.gapSec * fs ? 0 : Math.cos((2 * Math.PI * f[k] * local) / fs);
      }
    }
    if (c !== 'B') applyRamps(y, fs, o.rampSec);
    return y;
  }
  if (c === 'imd') {
    // each tone at half amplitude so the sum peaks at full scale: any IMD heard is the speaker's
    for (let i = 0; i < n; i++) y[i] = 0.5 * Math.cos((2 * Math.PI * o.imdF1 * i) / fs) + 0.5 * Math.cos((2 * Math.PI * o.imdF2 * i) / fs);
    applyRamps(y, fs, o.rampSec);
    return y;
  }
  for (let i = 0; i < n; i++) y[i] = Math.cos((2 * Math.PI * o.refFreq * i) / fs);
  applyRamps(y, fs, o.rampSec);
  return y;
}

export interface LeakageReport {
  case: AudibilityCase;
  /** Total power below fLow relative to total power, dB. */
  belowBandDbc: number;
  /** Strongest component below fLow − 100 Hz relative to the peak, dB. */
  worstBelowDbc: number;
  /** Power in the most audible region (< 16 kHz) relative to total, dB. */
  audibleDbc: number;
  spectrum: { freq: number; db: number }[];
}

/** Computed transmit spectrum of a case (no acoustics): proves what we put into the speaker. */
export function leakage(x: Float32Array, fs: number, c: AudibilityCase): LeakageReport {
  const s = welch(x, fs, 8192);
  return leakageFromSpectrum(s, fs, c);
}

function leakageFromSpectrum(s: Spectrum, fs: number, c: AudibilityCase): LeakageReport {
  const total = bandPowerDb(s, 0, fs / 2);
  const below = bandPowerDb(s, 20, DEFAULT_BAND.fLow);
  const audible = bandPowerDb(s, 20, 16000);
  const peak = peakIn(s, 20, fs / 2).db;
  let worst = -Infinity;
  for (let k = 0; k < s.freqs.length; k++) if (s.freqs[k] > 20 && s.freqs[k] < DEFAULT_BAND.fLow - 100) worst = Math.max(worst, s.db[k]);
  // decimate the plot to ~25 Hz resolution, keeping the max of each group
  const spectrum: { freq: number; db: number }[] = [];
  const g = Math.max(1, Math.round(25 / s.binHz));
  for (let k = 0; k < s.freqs.length; k += g) {
    let mx = -Infinity;
    for (let j = k; j < Math.min(s.freqs.length, k + g); j++) mx = Math.max(mx, s.db[j]);
    spectrum.push({ freq: round(s.freqs[k], 0), db: round(mx, 1) });
  }
  return {
    case: c,
    belowBandDbc: round(below - total, 1),
    worstBelowDbc: round(worst - peak, 1),
    audibleDbc: round(audible - total, 1),
    spectrum,
  };
}

// ---------------------------------------------------------------- measured IMD (self-recording)

/** Marker + gap + two-tone segment, so the recording can be aligned. */
export function imdRecordSignal(fs: number, o: AudibilityOptions = AUDIBILITY_DEFAULTS): Float32Array {
  const m = markerWave(fs);
  const t = audibilitySignal(fs, 'imd', o);
  const gap = Math.round(0.3 * fs);
  const y = new Float32Array(m.length + gap + t.length + Math.round(0.2 * fs));
  y.set(m);
  y.set(t, m.length + gap);
  return y;
}

export interface ImdResult {
  test: 'imd';
  fs: number;
  markerFound: boolean;
  toneDb: [number, number];
  /** f2−f1 difference tone (the audible one), 2f1−f2 and 2f2−f1 third-order products, dBFS. */
  diffDb: number;
  im3LowDb: number;
  im3HighDb: number;
  /** Difference tone relative to the weaker of the two tones, dBc. */
  diffDbc: number;
  noiseNearDiffDb: number;
  spectrum: { freq: number; db: number }[];
}

export function analyzeImd(rec: Float32Array, fs: number, o: AudibilityOptions = AUDIBILITY_DEFAULTS, expectedStart?: number): ImdResult {
  const hits = findMarkers(rec, fs);
  const anchor = hits.length ? hits[0].time : expectedStart ?? 0;
  const a = Math.round((anchor + 0.25 + 0.3 + o.rampSec + 0.05) * fs);
  const b = Math.min(rec.length, Math.round((anchor + 0.25 + 0.3 + o.durSec - o.rampSec) * fs));
  const seg = rec.subarray(Math.min(a, rec.length), Math.max(Math.min(a, rec.length), b));
  const s = welch(seg, fs, 8192);
  const at = (f: number, w = 30) => peakIn(s, f - w, f + w).db;
  const d = o.imdF2 - o.imdF1;
  const t1 = at(o.imdF1), t2 = at(o.imdF2);
  const diffDb = at(d);
  // local noise around the difference tone, excluding ±60 Hz
  let np = 0, nk = 0;
  for (let k = 0; k < s.freqs.length; k++) {
    const f = s.freqs[k];
    if (Math.abs(f - d) > 60 && Math.abs(f - d) < 300) { np += Math.pow(10, s.db[k] / 10); nk++; }
  }
  return {
    test: 'imd',
    fs,
    markerFound: hits.length > 0,
    toneDb: [round(t1), round(t2)],
    diffDb: round(diffDb),
    im3LowDb: round(at(2 * o.imdF1 - o.imdF2)),
    im3HighDb: round(2 * o.imdF2 - o.imdF1 < fs / 2 ? at(2 * o.imdF2 - o.imdF1) : NaN),
    diffDbc: round(diffDb - Math.min(t1, t2)),
    noiseNearDiffDb: round(10 * Math.log10(np / Math.max(1, nk))),
    spectrum: leakageFromSpectrum(s, fs, 'imd').spectrum,
  };
}
