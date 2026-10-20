import { fft, nextPow2 } from '../../src/dsp/fft.ts';
import { LayoutBuilder, locateMarker, rampedTone, render, segRange, noiseAmp, ampDb, mean, std, round, type Segment, TONE_RAMP } from './common.ts';

/**
 * Doppler / motion: a long steady tone while the operator slowly moves one device. Short-time
 * frequency and level tracks show how fast the channel changes — the frequency offset the
 * receiver must tolerate or track (1 m/s ≈ 52 Hz at 17.75 kHz) and the level fading.
 */
export interface DopplerOptions {
  freq: number;
  durSec: number;
  /** Analysis frame: 100 ms → raw 10 Hz bins, refined by zero-padding and interpolation. */
  frameSec: number;
  hopSec: number;
}

export const DOPPLER_DEFAULTS: DopplerOptions = { freq: 17750, durSec: 15, frameSec: 0.1, hopSec: 0.05 };

/** Speed of sound at ~20 °C, m/s. */
export const SOUND_SPEED = 343;
/** Search window around the nominal tone: ±5 m/s of relative motion. */
const SEARCH_HZ = 300;

export function dopplerLayout(o: DopplerOptions = DOPPLER_DEFAULTS): { segs: Segment[]; total: number } {
  const b = new LayoutBuilder();
  b.add({ name: 'silence', dur: 1 }, 0.1);
  b.add({ name: 'tone', freq: o.freq, dur: o.durSec });
  return { segs: b.segs, total: b.total(0.2) };
}

export function dopplerSignal(fs: number, o: DopplerOptions = DOPPLER_DEFAULTS): Float32Array {
  const { segs, total } = dopplerLayout(o);
  return render(fs, total, segs, (s) => (s.name === 'tone' ? rampedTone(s.freq!, s.dur, fs) : null));
}

export interface DopplerResult {
  test: 'doppler';
  fs: number;
  markerTime: number;
  series: { t: number; freq: number; levelDb: number }[];
  /** Mean offset from nominal: mostly the two devices' clock mismatch, in Hz and ppm. */
  meanOffsetHz: number;
  clockPpm: number;
  freqStdHz: number;
  /** Largest deviation from the mean frequency, Hz. */
  maxDevHz: number;
  peakToPeakHz: number;
  /** maxDev expressed as relative speed, m/s. */
  maxSpeedMs: number;
  /** Largest frame-to-frame frequency change, Hz/s (how fast a tracker must follow). */
  maxSlewHzPerS: number;
  levelStdDb: number;
  levelRangeDb: number;
  framesUsed: number;
}

export function analyzeDoppler(rec: Float32Array, fs: number, o: DopplerOptions = DOPPLER_DEFAULTS): DopplerResult {
  const m = locateMarker(rec, fs);
  const { segs } = dopplerLayout(o);
  const tone = segs.find((s) => s.name === 'tone')!;
  const sil = segs.find((s) => s.name === 'silence')!;
  const [sa, sb] = segRange(fs, m.time, sil, 0.2, rec.length);
  const noiseDb = ampDb(noiseAmp(rec, fs, o.freq, sa, sb, o.frameSec));
  const [a, b] = segRange(fs, m.time, tone, TONE_RAMP, rec.length);
  const L = Math.round(o.frameSec * fs);
  const hop = Math.round(o.hopSec * fs);
  // 8× zero padding puts FFT bins ~1.2 Hz apart; Gaussian interpolation on log power refines further
  const N = nextPow2(L * 8);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const w = new Float64Array(L);
  let ws = 0;
  for (let i = 0; i < L; i++) { w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1)); ws += w[i]; }
  const k0 = Math.floor(((o.freq - SEARCH_HZ) * N) / fs);
  const k1 = Math.ceil(((o.freq + SEARCH_HZ) * N) / fs);
  const series: DopplerResult['series'] = [];
  for (let s = a; s + L <= b; s += hop) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < L; i++) re[i] = rec[s + i] * w[i];
    fft(re, im);
    let kb = k0;
    let pb = -1;
    for (let k = k0; k <= k1; k++) {
      const p = re[k] ** 2 + im[k] ** 2;
      if (p > pb) { pb = p; kb = k; }
    }
    const lp = (k: number) => Math.log(re[k] ** 2 + im[k] ** 2 + 1e-30);
    const al = lp(kb - 1), bl = lp(kb), cl = lp(kb + 1);
    const den = al - 2 * bl + cl;
    const d = den === 0 ? 0 : (0.5 * (al - cl)) / den;
    const freq = ((kb + d) * fs) / N;
    const levelDb = ampDb((2 * Math.sqrt(pb)) / ws);
    series.push({ t: round((s - a) / fs, 3), freq: round(freq, 2), levelDb: round(levelDb) });
  }
  // frames within 10 dB of the noise have unreliable frequency estimates
  const used = series.filter((p) => p.levelDb - noiseDb >= 10);
  const f = used.map((p) => p.freq);
  const mf = mean(f);
  let slew = 0;
  for (let i = 1; i < used.length; i++) {
    const dt = used[i].t - used[i - 1].t;
    if (dt > 0 && dt <= 2 * o.hopSec + 1e-9) slew = Math.max(slew, Math.abs(used[i].freq - used[i - 1].freq) / dt);
  }
  const lv = used.map((p) => p.levelDb);
  const maxDev = f.length ? Math.max(...f.map((v) => Math.abs(v - mf))) : NaN;
  return {
    test: 'doppler',
    fs,
    markerTime: round(m.time, 4),
    series,
    meanOffsetHz: round(mf - o.freq),
    clockPpm: round(((mf - o.freq) / o.freq) * 1e6, 1),
    freqStdHz: round(std(f)),
    maxDevHz: round(maxDev),
    peakToPeakHz: round(f.length ? Math.max(...f) - Math.min(...f) : NaN),
    maxSpeedMs: round((maxDev / o.freq) * SOUND_SPEED, 3),
    maxSlewHzPerS: round(slew, 1),
    levelStdDb: round(std(lv)),
    levelRangeDb: round(lv.length ? Math.max(...lv) - Math.min(...lv) : NaN),
    framesUsed: used.length,
  };
}
