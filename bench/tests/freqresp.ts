import { welch, bandPowerDb } from '../../src/dsp/spectrum.ts';
import { DEFAULT_BAND } from '../../modem/band.ts';
import {
  LayoutBuilder, locateMarker, rampedSweep, rampedTone, render, segRange, toneAmp, noiseAmp,
  ampDb, round, type Segment, TONE_RAMP,
} from './common.ts';

/**
 * Frequency response & level: stepped tones across 16–19 kHz (wider than the band, so we see the
 * roll-off on both sides), a silence segment for the noise floor and a slow sweep for a
 * finer-grained curve. Reports level (dBFS), noise floor and SNR per frequency, and the best
 * contiguous 1.5 kHz sub-band for this device pair.
 */
export interface FreqRespOptions {
  fStart: number;
  fStop: number;
  stepHz: number;
  /** Each tone: long enough that a Hann-windowed measurement has ~10 Hz resolution. */
  toneSec: number;
  /** Gap between tones lets the previous tone's echo decay a little; the Hann window does the rest. */
  gapSec: number;
  silenceSec: number;
  sweepSec: number;
  /** Width of the sub-band search, Hz. */
  subBandHz: number;
}

export const FREQRESP_DEFAULTS: FreqRespOptions = {
  fStart: 16000,
  fStop: 19000,
  stepHz: 100,
  toneSec: 0.15,
  gapSec: 0.03,
  silenceSec: 1.2,
  sweepSec: 3,
  subBandHz: 1500,
};

export function freqRespLayout(o: FreqRespOptions = FREQRESP_DEFAULTS): { segs: Segment[]; total: number } {
  const b = new LayoutBuilder();
  for (let f = o.fStart; f <= o.fStop + 1e-6; f += o.stepHz) b.add({ name: 'tone', freq: f, dur: o.toneSec }, o.gapSec);
  b.gap(0.2);
  b.add({ name: 'silence', dur: o.silenceSec }, 0.1);
  b.add({ name: 'sweep', f0: o.fStart, f1: o.fStop, dur: o.sweepSec });
  return { segs: b.segs, total: b.total(0.4) };
}

export function freqRespSignal(fs: number, o: FreqRespOptions = FREQRESP_DEFAULTS): Float32Array {
  const { segs, total } = freqRespLayout(o);
  return render(fs, total, segs, (s) => {
    if (s.name === 'tone') return rampedTone(s.freq!, s.dur, fs);
    if (s.name === 'sweep') return rampedSweep(s.f0!, s.f1!, s.dur, fs);
    return null;
  });
}

export interface FreqRespPoint {
  freq: number;
  levelDb: number;
  noiseDb: number;
  snrDb: number;
}

export interface FreqRespResult {
  test: 'freqresp';
  fs: number;
  markerTime: number;
  markerScore: number;
  points: FreqRespPoint[];
  /** Finer curve from the sweep (20 ms frames), dBFS. */
  sweep: { freq: number; levelDb: number }[];
  /** In-band (fLow..fHigh) noise power from the silence segment, dBFS, and its density dBFS/Hz. */
  inBandNoiseDb: number;
  inBandNoiseDensityDb: number;
  defaultBand: { fLow: number; fHigh: number; minSnrDb: number; meanSnrDb: number };
  bestSubBand: { fLow: number; fHigh: number; minSnrDb: number; meanSnrDb: number };
}

export function analyzeFreqResp(rec: Float32Array, fs: number, o: FreqRespOptions = FREQRESP_DEFAULTS): FreqRespResult {
  const m = locateMarker(rec, fs);
  const { segs } = freqRespLayout(o);
  const sil = segs.find((s) => s.name === 'silence')!;
  // skip the first 0.3 s of silence so the last tone's reverb tail is not counted as noise
  const [sa, sb] = segRange(fs, m.time, sil, 0.3, rec.length);
  // measure tones over their middle, past the ramps and the first 20 ms of room build-up
  const trim = TONE_RAMP + 0.02;
  const block = o.toneSec - 2 * trim;
  const points: FreqRespPoint[] = [];
  for (const s of segs) {
    if (s.name !== 'tone') continue;
    const [a, b] = segRange(fs, m.time, s, trim, rec.length);
    const levelDb = ampDb(toneAmp(rec, fs, s.freq!, a, b));
    const noiseDb = ampDb(noiseAmp(rec, fs, s.freq!, sa, sb, block));
    points.push({ freq: s.freq!, levelDb: round(levelDb), noiseDb: round(noiseDb), snrDb: round(levelDb - noiseDb) });
  }

  const sw = segs.find((s) => s.name === 'sweep')!;
  const frame = 0.02;
  const sweep: { freq: number; levelDb: number }[] = [];
  for (let t = TONE_RAMP; t + frame <= sw.dur - TONE_RAMP; t += frame) {
    const a = Math.round((m.time + sw.start + t) * fs);
    const b = Math.round((m.time + sw.start + t + frame) * fs);
    if (b > rec.length) break;
    const f = sw.f0! + ((sw.f1! - sw.f0!) * (t + frame / 2)) / sw.dur;
    // the sweep moves (f1−f0)/dur·frame ≈ 20 Hz per frame, inside the Hann main lobe (±100 Hz)
    sweep.push({ freq: round(f, 0), levelDb: round(ampDb(toneAmp(rec, fs, f, a, b))) });
  }

  const spec = welch(rec.subarray(sa, sb), fs, 4096);
  const inBandNoiseDb = bandPowerDb(spec, DEFAULT_BAND.fLow, DEFAULT_BAND.fHigh);
  const inBandNoiseDensityDb = inBandNoiseDb - 10 * Math.log10(DEFAULT_BAND.fHigh - DEFAULT_BAND.fLow);

  const bandStats = (lo: number, hi: number) => {
    const sn = points.filter((p) => p.freq >= lo - 1e-6 && p.freq <= hi + 1e-6).map((p) => p.snrDb);
    return {
      fLow: lo,
      fHigh: hi,
      minSnrDb: round(Math.min(...sn)),
      meanSnrDb: round(10 * Math.log10(sn.reduce((acc, v) => acc + Math.pow(10, v / 10), 0) / sn.length)),
    };
  };
  // Best sub-band ranks by the worst tone in it: a dip anywhere in the band costs symbols.
  let best = bandStats(o.fStart, o.fStart + o.subBandHz);
  for (let lo = o.fStart; lo + o.subBandHz <= o.fStop + 1e-6; lo += o.stepHz) {
    const s = bandStats(lo, lo + o.subBandHz);
    if (s.minSnrDb > best.minSnrDb || (s.minSnrDb === best.minSnrDb && s.meanSnrDb > best.meanSnrDb)) best = s;
  }
  return {
    test: 'freqresp',
    fs,
    markerTime: round(m.time, 4),
    markerScore: round(m.score, 3),
    points,
    sweep,
    inBandNoiseDb: round(inBandNoiseDb),
    inBandNoiseDensityDb: round(inBandNoiseDensityDb),
    defaultBand: bandStats(DEFAULT_BAND.fLow, DEFAULT_BAND.fHigh),
    bestSubBand: best,
  };
}
