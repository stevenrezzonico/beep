import { describe, expect, it } from 'vitest';
import { applyChannel } from './testchannel.ts';
import { freqRespSignal, analyzeFreqResp } from './freqresp.ts';
import { aecSignal, analyzeAec, remoteMicSignal, analyzeRemoteMic, remoteMicLayout, micVerdict } from './miccheck.ts';
import { echoSignal, analyzeEcho } from './echo.ts';
import { distanceSignal, analyzeDistance, fitDistance, distanceCsv } from './distance.ts';
import { dopplerLayout, analyzeDoppler, DOPPLER_DEFAULTS } from './doppler.ts';
import { audibilitySignal, leakage, imdRecordSignal, analyzeImd } from './audibility.ts';
import { render, MarkerNotFound } from './common.ts';
import { applyRamps } from '../../src/dsp/signal.ts';

const RATES = [44100, 48000];

describe('frequency response', () => {
  it('reads a flat channel as flat with high SNR, at both rates', () => {
    for (const fs of RATES) {
      const rec = applyChannel(freqRespSignal(fs), fs, { gainDb: -20, delaySec: 1.3, noiseRms: 1e-3, seed: fs });
      const r = analyzeFreqResp(rec, fs);
      expect(r.points.length).toBe(31);
      for (const p of r.points) {
        expect(Math.abs(p.levelDb + 20)).toBeLessThan(0.5);
        expect(p.snrDb).toBeGreaterThan(40);
      }
      for (const p of r.sweep) expect(Math.abs(p.levelDb + 20)).toBeLessThan(1);
      expect(r.defaultBand.minSnrDb).toBeGreaterThan(40);
      // white noise σ=1e-3 has power 1e-6 = −57 dBFS (0 dBFS = full-scale sine, power ½);
      // 1.5 kHz of it is 10·log10(1500/(fs/2)) lower
      expect(Math.abs(r.inBandNoiseDb - (-57 + 10 * Math.log10(1500 / (fs / 2))))).toBeLessThan(1);
    }
  });
  it('finds the lowest sub-band when the mic rolls off', () => {
    const fs = 48000;
    // speaker roll-off acts on the signal only; noise is added after it
    const rolled = applyChannel(freqRespSignal(fs), fs, { gainDb: -20, lowpassHz: 16500, tailSec: 0 });
    const rec = applyChannel(rolled, fs, { delaySec: 0.7, noiseRms: 1e-3 });
    const r = analyzeFreqResp(rec, fs);
    expect(r.bestSubBand.fLow).toBe(16000);
    expect(r.points.at(-1)!.snrDb).toBeLessThan(r.points[0].snrDb - 20);
  });
  it('fails clearly when there is no marker', () => {
    const fs = 48000;
    expect(() => analyzeFreqResp(new Float32Array(fs * 3), fs)).toThrow(MarkerNotFound);
  });
});

describe('mic check: AEC self-test', () => {
  const fs = 48000;
  it('clean path → AEC off, no low-pass', () => {
    const rec = applyChannel(aecSignal(fs), fs, { gainDb: -15, delaySec: 0.5, noiseRms: 1e-3 });
    const r = analyzeAec(rec, fs, 0.5);
    expect(r.markerFound).toBe(true);
    expect(r.lowpass).toBe('no');
    expect(r.aecOff).toBe('yes');
    expect(Math.abs(r.dropDb)).toBeLessThan(1);
  });
  it('voice-path low-pass → low-pass yes, AEC not off', () => {
    const rec = applyChannel(aecSignal(fs), fs, { gainDb: -15, delaySec: 0.5, noiseRms: 1e-3, lowpassHz: 8000 });
    const r = analyzeAec(rec, fs, 0.5);
    expect(r.lowpass).toBe('yes');
    expect(r.aecOff).toBe('no');
  });
  it('an adapting canceller → AEC on', () => {
    const x = aecSignal(fs);
    // emulate AEC: own playback suppressed by 25 dB with a 0.8 s adaptation time constant
    for (let i = 0; i < x.length; i++) x[i] *= 0.056 + 0.944 * Math.exp(-i / fs / 0.8);
    const rec = applyChannel(x, fs, { gainDb: -15, delaySec: 0.5, noiseRms: 1e-4 });
    const r = analyzeAec(rec, fs, 0.5);
    expect(r.aecOff).toBe('no');
    expect(r.dropDb).toBeGreaterThan(6);
  });
});

describe('mic check: remote AGC / NS', () => {
  const fs = 44100;
  it('linear chain → AGC off, NS off', () => {
    const rec = applyChannel(remoteMicSignal(fs), fs, { gainDb: -12, delaySec: 2, noiseRms: 3e-4 });
    const r = analyzeRemoteMic(rec, fs);
    expect(r.agcSlope).toBeGreaterThan(0.95);
    expect(r.agcSlope).toBeLessThan(1.05);
    expect(r.agcOff).toBe('yes');
    expect(r.nsOff).toBe('yes');
    const v = micVerdict(undefined, r, { autoGainControl: false });
    expect(v.agcOff).toBe('yes');
    expect(v.aecOff).toBe('unknown');
  });
  it('AGC compresses steps → AGC on', () => {
    const rec = applyChannel(remoteMicSignal(fs), fs, { gainDb: -12, delaySec: 2, noiseRms: 3e-4, agc: { targetDb: -20, tau: 0.3 } });
    const r = analyzeRemoteMic(rec, fs);
    expect(r.agcOff).toBe('no');
    const v = micVerdict(undefined, r, { autoGainControl: false });
    expect(v.consequences.some((c) => c.includes('cannot be trusted') || c.includes('measurably'))).toBe(true);
  });
  it('NS fading a steady tone → NS on', () => {
    const x = remoteMicSignal(fs);
    const ns = remoteMicLayout().segs.find((s) => s.name === 'ns')!;
    const a = Math.round(ns.start * fs);
    // emulate NS: stationary component attenuated by 15 dB with a 2 s time constant
    for (let i = a; i < x.length; i++) x[i] *= 0.18 + 0.82 * Math.exp(-(i - a) / fs / 2);
    const rec = applyChannel(x, fs, { gainDb: -12, delaySec: 1, noiseRms: 3e-4 });
    const r = analyzeRemoteMic(rec, fs);
    expect(r.nsOff).toBe('no');
    expect(r.agcOff).toBe('yes');
  });
});

describe('echo / reverb', () => {
  it('recovers RT60 and exports an IR', () => {
    const fs = 44100;
    const rec = applyChannel(echoSignal(fs), fs, { gainDb: -10, delaySec: 0.8, noiseRms: 2e-5, rt60: 0.4, drrDb: 0, seed: 3 });
    const { result, ir } = analyzeEcho(rec, fs);
    expect(result.burstsUsed).toBe(4);
    expect(result.rt60FromT20).not.toBeNull();
    expect(Math.abs(result.rt60FromT20! - 0.4)).toBeLessThan(0.08);
    expect(Math.abs(result.drrDb - 0)).toBeLessThan(3);
    expect(result.tMinus20).not.toBeNull();
    expect(ir.fs).toBe(fs);
    expect(ir.ir.length).toBeGreaterThan(0.2 * fs);
  });
  it('dry room → short decay, high DRR', () => {
    const fs = 48000;
    const rec = applyChannel(echoSignal(fs), fs, { gainDb: -10, delaySec: 0.8, noiseRms: 2e-5, rt60: 0.15, drrDb: 10, seed: 4 });
    const { result } = analyzeEcho(rec, fs);
    expect(result.drrDb).toBeGreaterThan(7);
    expect(result.rt60FromT20 ?? result.edtSec!).toBeLessThan(0.25);
  });
});

describe('attenuation vs distance', () => {
  it('fits spreading + absorption', () => {
    const fs = 48000;
    const alpha = 0.8;
    const rows = [1, 2, 4, 6, 8].map((d, i) => {
      const gainDb = -10 - 20 * Math.log10(d) - alpha * d;
      const rec = applyChannel(distanceSignal(fs), fs, { gainDb, delaySec: 1, noiseRms: 3e-5, seed: 10 + i });
      return analyzeDistance(rec, fs, d);
    });
    for (const r of rows) expect(r.snrDb).toBeGreaterThan(20);
    const fit = fitDistance(rows, 0);
    expect(Math.abs(fit.spreadingPlusAbsorption!.alphaDbPerM - alpha)).toBeLessThan(0.05);
    expect(Math.abs(fit.spreadingPlusAbsorption!.L0 + 10)).toBeLessThan(0.5);
    expect(fit.rangeAtSnr!.distanceM).toBeGreaterThan(8);
    expect(distanceCsv(rows).split('\n').length).toBe(6);
  });
});

describe('doppler', () => {
  it('tracks a ±20 Hz wobble and the clock offset', () => {
    const fs = 48000;
    const o = DOPPLER_DEFAULTS;
    const { segs, total } = dopplerLayout(o);
    const x = render(fs, total, segs, (s) => {
      if (s.name !== 'tone') return null;
      const n = Math.round(s.dur * fs);
      const y = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        // 40 ppm clock offset between the devices plus a ±20 Hz motion wobble
        ph += (2 * Math.PI * (o.freq * (1 + 40e-6) + 20 * Math.sin((2 * Math.PI * 0.4 * i) / fs))) / fs;
        y[i] = Math.cos(ph);
      }
      applyRamps(y, fs, 0.01);
      return y;
    });
    const rec = applyChannel(x, fs, { gainDb: -20, delaySec: 1, noiseRms: 1e-3 });
    const r = analyzeDoppler(rec, fs);
    expect(Math.abs(r.peakToPeakHz / 2 - 20)).toBeLessThan(1);
    expect(Math.abs(r.maxDevHz - 20)).toBeLessThan(2);
    expect(Math.abs(r.clockPpm - 40)).toBeLessThan(15);
    expect(r.maxSpeedMs).toBeGreaterThan(0.3);
    expect(r.levelStdDb).toBeLessThan(0.5);
  });
});

describe('audibility', () => {
  it('ramped continuous-phase stream keeps far less energy below the band than the hard-gated one', () => {
    const fs = 48000;
    const a = leakage(audibilitySignal(fs, 'A'), fs, 'A');
    const b = leakage(audibilitySignal(fs, 'B'), fs, 'B');
    const a2 = leakage(audibilitySignal(fs, 'A2'), fs, 'A2');
    expect(a.audibleDbc).toBeLessThan(b.audibleDbc - 15);
    expect(a.belowBandDbc).toBeLessThan(b.belowBandDbc - 5);
    // smoothing the frequency transitions buys a lot more below 16 kHz
    expect(a2.audibleDbc).toBeLessThan(a.audibleDbc - 15);
  });
  it('measures a speaker difference tone', () => {
    const fs = 48000;
    const x = imdRecordSignal(fs);
    // quadratic speaker nonlinearity
    const y = new Float32Array(x.length + fs);
    for (let i = 0; i < x.length; i++) y[i + fs / 2] = 0.5 * (x[i] + 0.1 * x[i] * x[i]);
    const r = analyzeImd(y, fs);
    expect(Math.abs(r.diffDbc - -26)).toBeLessThan(1.5);
  });
});
