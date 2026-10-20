import { welch, bandPowerDb } from '../../src/dsp/spectrum.ts';
import { findMarkers } from '../../src/dsp/marker.ts';
import { dbToLin } from '../../src/dsp/signal.ts';
import {
  LayoutBuilder, locateMarker, rampedSweep, rampedTone, render, segRange, toneAmp, noiseAmp,
  frameLevelsDb, ampDb, median, std, linfit, round, type Segment, type Verdict, TONE_RAMP,
} from './common.ts';

/**
 * Empirical mic-processing check. The getUserMedia API can report echoCancellation=false while
 * the platform's voice-processing path is still active (WebKit has done this), so we measure:
 *  (a) AEC self-test — the device plays a steady in-band tone and a 16–19 kHz sweep while it
 *      records itself. An echo canceller suppresses (or modulates, while adapting) its own
 *      playback; a voice-processing path also low-passes the mic well below 17 kHz.
 *  (b) AGC — the other device sends a tone in level steps; without AGC the received level steps
 *      1 dB per dB, with AGC the slope collapses and each step "pumps" towards a target.
 *  (c) Noise suppression — a long steady tone looks like stationary noise to NS, which then
 *      fades or gates it.
 */

const TONE_HZ = 17750; // band centre
const FRAME = 0.1; // level frames: 10 Hz resolution, fast enough to see AGC/AEC adaptation (~0.1–1 s)

// ---------------------------------------------------------------- (a) AEC self-test

export interface AecOptions {
  toneSec: number;
  sweepSec: number;
  ambientSec: number;
}
export const AEC_DEFAULTS: AecOptions = { toneSec: 6, sweepSec: 3, ambientSec: 2 };

export function aecLayout(o: AecOptions = AEC_DEFAULTS): { segs: Segment[]; total: number } {
  const b = new LayoutBuilder();
  b.add({ name: 'tone', freq: TONE_HZ, dur: o.toneSec }, 0.3);
  b.add({ name: 'sweep', f0: 16000, f1: 19000, dur: o.sweepSec }, 0.5);
  b.add({ name: 'ambient', dur: o.ambientSec });
  return { segs: b.segs, total: b.total(0.1) };
}

export function aecSignal(fs: number, o: AecOptions = AEC_DEFAULTS): Float32Array {
  const { segs, total } = aecLayout(o);
  return render(fs, total, segs, (s) => {
    if (s.name === 'tone') return rampedTone(s.freq!, s.dur, fs);
    if (s.name === 'sweep') return rampedSweep(s.f0!, s.f1!, s.dur, fs);
    return null;
  });
}

export interface AecResult {
  test: 'aec-self';
  fs: number;
  markerFound: boolean;
  /** Where the analysis was anchored (marker time or the expected start fallback), s. */
  anchor: number;
  onsetDb: number;
  steadyDb: number;
  /** onset − steady: positive means the device suppressed its own playback over time. */
  dropDb: number;
  /** Std of 100 ms frame levels over the last 4 s: an adapting canceller modulates the level. */
  modulationDb: number;
  toneSnrDb: number;
  /** Sweep level at 500 Hz steps (dBFS). */
  sweepDb: { freq: number; levelDb: number }[];
  /** Ambient noise density in 12–15 kHz and 17–18.5 kHz, dBFS/Hz. */
  ambientLowDensityDb: number;
  ambientBandDensityDb: number;
  lowpass: Verdict;
  aecOff: Verdict;
  notes: string[];
}

/**
 * @param expectedStart seconds into the recording where playback was scheduled; used only if the
 *   marker itself was cancelled or filtered away (which is itself evidence).
 */
export function analyzeAec(rec: Float32Array, fs: number, expectedStart?: number, o: AecOptions = AEC_DEFAULTS): AecResult {
  const notes: string[] = [];
  const hits = findMarkers(rec, fs);
  let anchor: number;
  if (hits.length) anchor = hits[0].time;
  else if (expectedStart !== undefined) {
    anchor = expectedStart;
    notes.push('marker not found: own playback suppressed or low-passed; analysing at the scheduled start (±output latency)');
  } else throw new Error('marker not found and no expected start given');

  const { segs } = aecLayout(o);
  const seg = (n: string) => segs.find((s) => s.name === n)!;
  const [aa, ab] = segRange(fs, anchor, seg('ambient'), 0.1, rec.length);
  const amb = rec.subarray(aa, ab);
  const silent = amb.every((v) => v === 0);
  const spec = welch(amb, fs, 4096);
  const ambientLowDensityDb = bandPowerDb(spec, 12000, 15000) - 10 * Math.log10(3000);
  const ambientBandDensityDb = bandPowerDb(spec, 17000, 18500) - 10 * Math.log10(1500);

  // Low-pass check: a voice path cuts the band to (near) digital silence while 12–15 kHz still
  // carries mic self-noise. A real mic's floor is roughly flat there (a few dB tilt), so a drop
  // of >25 dB is a filter, not acoustics. Below −150 dBFS/Hz is numerically silent.
  let lowpass: Verdict = 'unknown';
  if (silent) notes.push('ambient segment is digital silence: mic muted or blocked');
  else if (ambientBandDensityDb < -150 || ambientLowDensityDb - ambientBandDensityDb > 25) lowpass = 'yes';
  else if (ambientLowDensityDb - ambientBandDensityDb < 15) lowpass = 'no';

  const tone = seg('tone');
  const [ta, tb] = segRange(fs, anchor, tone, TONE_RAMP, rec.length);
  const frames = frameLevelsDb(rec, fs, TONE_HZ, ta, tb, FRAME);
  const onsetDb = median(frames.slice(0, 3));
  const steadyDb = median(frames.slice(-20));
  const modulationDb = std(frames.slice(-40));
  const noiseDb = ampDb(noiseAmp(rec, fs, TONE_HZ, aa, ab, FRAME));
  const toneSnrDb = steadyDb - noiseDb;

  const sw = seg('sweep');
  const sweepDb: { freq: number; levelDb: number }[] = [];
  for (let f = 16000; f <= 19000; f += 500) {
    const tc = sw.start + ((f - sw.f0!) / (sw.f1! - sw.f0!)) * sw.dur;
    const a = Math.round((anchor + Math.max(sw.start + TONE_RAMP, tc - 0.025)) * fs);
    const b = Math.round((anchor + Math.min(sw.start + sw.dur - TONE_RAMP, tc + 0.025)) * fs);
    sweepDb.push({ freq: f, levelDb: round(b > a && b <= rec.length ? ampDb(toneAmp(rec, fs, f, a, b)) : NaN) });
  }

  // Thresholds: with both transducers fixed on one device, the acoustic path is static, so a
  // drop >6 dB or a frame std >3 dB can only come from processing (a converged AEC removes
  // ≥20 dB); a path with no processing stays within ~1 dB.
  let aecOff: Verdict = 'unknown';
  if (lowpass === 'yes') {
    aecOff = 'no';
    notes.push('band is low-passed: the voice-processing (AEC) path is active');
  } else if (toneSnrDb < 6) {
    notes.push('own tone not heard (SNR < 6 dB): either AEC removed it fully or the speaker/mic cannot reach 17.75 kHz; raise volume and rerun');
  } else if (onsetDb - steadyDb > 6 || modulationDb > 3) aecOff = 'no';
  else if (Math.abs(onsetDb - steadyDb) < 2 && modulationDb < 1.5) aecOff = 'yes';

  return {
    test: 'aec-self',
    fs,
    markerFound: hits.length > 0,
    anchor: round(anchor, 4),
    onsetDb: round(onsetDb),
    steadyDb: round(steadyDb),
    dropDb: round(onsetDb - steadyDb),
    modulationDb: round(modulationDb),
    toneSnrDb: round(toneSnrDb),
    sweepDb,
    ambientLowDensityDb: round(ambientLowDensityDb),
    ambientBandDensityDb: round(ambientBandDensityDb),
    lowpass,
    aecOff,
    notes,
  };
}

// ---------------------------------------------------------------- (b)+(c) remote AGC / NS

export interface RemoteMicOptions {
  /** Sent tone levels, dBFS relative to the TX gain. 10 dB apart so AGC pumping is unambiguous. */
  levelsDb: number[];
  stepSec: number;
  stepGapSec: number;
  /** Long steady tone for the noise-suppression check: NS estimators adapt over 1–5 s. */
  nsSec: number;
  silenceSec: number;
}
export const REMOTE_DEFAULTS: RemoteMicOptions = { levelsDb: [-30, -20, -10, 0], stepSec: 2, stepGapSec: 0.5, nsSec: 10, silenceSec: 1.5 };

export function remoteMicLayout(o: RemoteMicOptions = REMOTE_DEFAULTS): { segs: Segment[]; total: number } {
  const b = new LayoutBuilder();
  b.add({ name: 'silence', dur: o.silenceSec }, 0.1);
  for (const l of o.levelsDb) b.add({ name: 'step', freq: TONE_HZ, levelDb: l, dur: o.stepSec }, o.stepGapSec);
  b.add({ name: 'ns', freq: TONE_HZ, dur: o.nsSec });
  return { segs: b.segs, total: b.total(0.3) };
}

export function remoteMicSignal(fs: number, o: RemoteMicOptions = REMOTE_DEFAULTS): Float32Array {
  const { segs, total } = remoteMicLayout(o);
  return render(fs, total, segs, (s) => {
    if (s.name === 'step') return rampedTone(s.freq!, s.dur, fs, dbToLin(s.levelDb!));
    if (s.name === 'ns') return rampedTone(s.freq!, s.dur, fs, dbToLin(-10));
    return null;
  });
}

export interface RemoteMicResult {
  test: 'mic-remote';
  fs: number;
  markerTime: number;
  noiseDb: number;
  steps: { sentDb: number; rxDb: number; firstDb: number; lastDb: number; pumpDb: number; snrDb: number; clipped: boolean }[];
  /** Slope of received vs sent level over usable steps: 1 = linear, <1 = compressed by AGC. */
  agcSlope: number;
  maxPumpDb: number;
  /** NS: first-second minus last-2-s level of the long tone; fraction of frames >10 dB below median. */
  nsDecayDb: number;
  nsGatedFraction: number;
  nsStdDb: number;
  nsSnrDb: number;
  agcOff: Verdict;
  nsOff: Verdict;
  notes: string[];
}

export function analyzeRemoteMic(rec: Float32Array, fs: number, o: RemoteMicOptions = REMOTE_DEFAULTS): RemoteMicResult {
  const m = locateMarker(rec, fs);
  const { segs } = remoteMicLayout(o);
  const notes: string[] = [];
  const sil = segs.find((s) => s.name === 'silence')!;
  const [sa, sb] = segRange(fs, m.time, sil, 0.1, rec.length);
  const noiseDb = ampDb(noiseAmp(rec, fs, TONE_HZ, sa, sb, FRAME));

  const steps: RemoteMicResult['steps'] = [];
  for (const s of segs.filter((x) => x.name === 'step')) {
    const [a, b] = segRange(fs, m.time, s, TONE_RAMP, rec.length);
    const fr = frameLevelsDb(rec, fs, TONE_HZ, a, b, FRAME);
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(rec[i]));
    const rxDb = median(fr.slice(Math.floor(fr.length / 2)));
    const firstDb = median(fr.slice(0, 2));
    const lastDb = median(fr.slice(-3));
    steps.push({
      sentDb: s.levelDb!, rxDb: round(rxDb), firstDb: round(firstDb), lastDb: round(lastDb),
      pumpDb: round(firstDb - lastDb), snrDb: round(rxDb - noiseDb), clipped: peak > 0.99,
    });
  }
  // Steps under 10 dB SNR are dominated by noise; clipped steps are compressed by the ADC, not AGC.
  const usable = steps.filter((s) => s.snrDb >= 10 && !s.clipped);
  const fit = usable.length >= 2 ? linfit(usable.map((s) => s.sentDb), usable.map((s) => s.rxDb)) : null;
  const agcSlope = fit ? fit.b : NaN;
  const maxPumpDb = usable.length ? Math.max(...usable.map((s) => Math.abs(s.pumpDb))) : NaN;
  if (steps.some((s) => s.clipped)) notes.push('some steps clipped at the receiver: lower the TX volume');

  // AGC thresholds: a 10 dB step through a linear chain moves 10±1 dB (slope 0.85–1.15 allows
  // for speaker compression near 0 dBFS); typical phone AGCs reach >5 dB/step compression and
  // settle in 0.2–1 s, which shows as pumping between the first and last frames of a step.
  let agcOff: Verdict = 'unknown';
  if (usable.length < 3) notes.push('fewer than 3 usable AGC steps (need ≥10 dB SNR): move closer or raise volume');
  else if (agcSlope < 0.7 || maxPumpDb > 3) agcOff = 'no';
  else if (agcSlope > 0.85 && agcSlope < 1.15 && maxPumpDb < 2) agcOff = 'yes';

  const ns = segs.find((s) => s.name === 'ns')!;
  const [na, nb] = segRange(fs, m.time, ns, TONE_RAMP, rec.length);
  const fr = frameLevelsDb(rec, fs, TONE_HZ, na, nb, FRAME);
  const med = median(fr);
  const nsDecayDb = median(fr.slice(0, 10)) - median(fr.slice(-20));
  const nsGatedFraction = fr.filter((v) => v < med - 10).length / Math.max(1, fr.length);
  const nsStdDb = std(fr);
  const nsSnrDb = med - noiseDb;
  // NS thresholds: a stationary tone through a still channel varies <1.5 dB; NS attenuation of
  // stationary components is typically 6–20 dB, or it gates (drops frames to the floor).
  let nsOff: Verdict = 'unknown';
  if (nsSnrDb < 10) notes.push('long tone below 10 dB SNR: NS verdict not possible');
  else if (nsDecayDb > 6 || nsGatedFraction > 0.05) nsOff = 'no';
  else if (Math.abs(nsDecayDb) < 2 && nsGatedFraction === 0 && nsStdDb < 1.5) nsOff = 'yes';

  return {
    test: 'mic-remote',
    fs,
    markerTime: round(m.time, 4),
    noiseDb: round(noiseDb),
    steps,
    agcSlope: round(agcSlope, 3),
    maxPumpDb: round(maxPumpDb),
    nsDecayDb: round(nsDecayDb),
    nsGatedFraction: round(nsGatedFraction, 3),
    nsStdDb: round(nsStdDb),
    nsSnrDb: round(nsSnrDb),
    agcOff,
    nsOff,
    notes,
  };
}

// ---------------------------------------------------------------- verdict

export interface MicVerdict {
  aecOff: Verdict;
  agcOff: Verdict;
  nsOff: Verdict;
  lowpass: Verdict;
  /** What the API claimed (getSettings after acquisition), for comparison. */
  apiReported?: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean };
  consequences: string[];
}

/** Combine the empirical results and spell out what they mean for the modem. */
export function micVerdict(aec?: AecResult, remote?: RemoteMicResult, api?: MicVerdict['apiReported']): MicVerdict {
  const v: MicVerdict = {
    aecOff: aec?.aecOff ?? 'unknown',
    agcOff: remote?.agcOff ?? 'unknown',
    nsOff: remote?.nsOff ?? 'unknown',
    lowpass: aec?.lowpass ?? 'unknown',
    apiReported: api,
    consequences: [],
  };
  if (v.lowpass === 'yes') v.consequences.push('Mic is low-passed below the band: the modem cannot receive on this device/config. Try another audioSession type or acquisition order.');
  if (v.aecOff === 'no') v.consequences.push('AEC active: own playback is cancelled, so full-duplex (listen while sending) is impossible; half-duplex required. AEC may also distort far-end in-band signals while it adapts.');
  if (v.agcOff === 'no') v.consequences.push('AGC active: received level is not proportional to sent level and pumps at onsets; detector thresholds must be level-independent (normalised correlation / peak-to-mean ratios), and the preamble must be long enough for AGC to settle.');
  if (v.nsOff === 'no') v.consequences.push('Noise suppression active: steady tones fade or gate; avoid long constant tones (chirps/hopping survive better) and keep packets short.');
  if (api) {
    if (api.echoCancellation === false && v.aecOff === 'no') v.consequences.push('API reports echoCancellation=false but processing is measurably active: the API cannot be trusted on this device.');
    if (api.autoGainControl === false && v.agcOff === 'no') v.consequences.push('API reports autoGainControl=false but AGC is measurably active.');
    if (api.noiseSuppression === false && v.nsOff === 'no') v.consequences.push('API reports noiseSuppression=false but NS is measurably active.');
  }
  return v;
}
