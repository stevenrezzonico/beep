import { describe, expect, it } from 'vitest';
import { fft, ifft } from './fft.ts';
import { designLowpass, firResponse } from './kaiser.ts';
import { Downconverter } from './decimator.ts';
import { interpComplex } from './interp.ts';
import { Rng } from './prng.ts';
import { welch, peakIn, goertzelAmp } from './spectrum.ts';
import { tone } from './signal.ts';

describe('fft', () => {
  it('matches a naive DFT and inverts', () => {
    const n = 64;
    const rng = new Rng(3);
    const re = new Float64Array(n).map(() => rng.gauss());
    const im = new Float64Array(n).map(() => rng.gauss());
    const r0 = re.slice(), i0 = im.slice();
    fft(re, im);
    for (const k of [0, 1, 7, 33, 63]) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += r0[t] * Math.cos(a) - i0[t] * Math.sin(a);
        si += r0[t] * Math.sin(a) + i0[t] * Math.cos(a);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
    ifft(re, im);
    for (let t = 0; t < n; t++) {
      expect(re[t]).toBeCloseTo(r0[t], 9);
      expect(im[t]).toBeCloseTo(i0[t], 9);
    }
  });
});

describe('kaiser lowpass', () => {
  it('meets the spec at both sample rates', () => {
    for (const fs of [44100, 48000]) {
      const h = designLowpass({ fs, passHz: 650, stopHz: 750, attenDb: 60 });
      expect(firResponse(h, 0, fs)).toBeCloseTo(1, 6);
      expect(Math.abs(20 * Math.log10(firResponse(h, 600, fs)))).toBeLessThan(0.1);
      for (const f of [760, 900, 2000, 5000]) expect(20 * Math.log10(firResponse(h, f, fs))).toBeLessThan(-59);
    }
  });
});

describe('downconverter', () => {
  const make = (fs: number) => new Downconverter({ fs, fCenter: 17750, passHalfHz: 650, stopHalfHz: 750 });

  it('is chunk-invariant (bit-identical output for any chunking)', () => {
    const fs = 48000;
    const rng = new Rng(11);
    const x = new Float32Array(fs / 2).map(() => rng.gauss());
    const a = make(fs), b = make(fs);
    const ar: number[] = [], ai: number[] = [], br: number[] = [], bi: number[] = [];
    a.process(x, ar, ai);
    let o = 0;
    while (o < x.length) {
      const n = 1 + rng.int(700);
      b.process(x.subarray(o, o + n), br, bi);
      o += n;
    }
    expect(br).toEqual(ar);
    expect(bi).toEqual(ai);
  });

  it('passes in-band tones and rejects out-of-band ones', () => {
    for (const fs of [44100, 48000]) {
      const measure = (f: number) => {
        const d = make(fs);
        const re: number[] = [], im: number[] = [];
        d.process(tone(f, 0.5, fs), re, im);
        let p = 0, n = 0;
        for (let i = Math.floor(re.length / 2); i < re.length; i++) { p += re[i] ** 2 + im[i] ** 2; n++; }
        return 10 * Math.log10(p / n / 0.25); // mixing halves the amplitude
      };
      expect(Math.abs(measure(17750))).toBeLessThan(0.1);
      expect(Math.abs(measure(17200))).toBeLessThan(0.1);
      expect(Math.abs(measure(18300))).toBeLessThan(0.1);
      expect(measure(16900)).toBeLessThan(-55);
      expect(measure(18600)).toBeLessThan(-55);
      expect(measure(15000)).toBeLessThan(-55);
      expect(measure(1000)).toBeLessThan(-55);
    }
  });

  it('reports the right timing (group delay)', () => {
    const fs = 44100;
    const d = make(fs);
    const x = new Float32Array(fs);
    const t0 = 0.3;
    // short tone burst starting at t0, check envelope midpoint
    const burst = tone(17750, 0.2, fs);
    x.set(burst, Math.round(t0 * fs));
    const re: number[] = [], im: number[] = [];
    d.process(x, re, im);
    const mag = re.map((r, i) => Math.hypot(r, im[i]));
    const thr = 0.25; // half of the 0.5 baseband amplitude
    const m = mag.findIndex((v) => v > thr);
    // linear interpolate crossing
    const tm = d.timeOf(m - 1 + (thr - mag[m - 1]) / (mag[m] - mag[m - 1]));
    expect(Math.abs(tm - t0)).toBeLessThan(0.0005);
  });
});

describe('interp', () => {
  it('reconstructs a band-limited complex tone at fractional instants', () => {
    const fs = 4000;
    const f = 600;
    const n = 400;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = Math.cos((2 * Math.PI * f * i) / fs); im[i] = Math.sin((2 * Math.PI * f * i) / fs); }
    const o = { re: 0, im: 0 };
    let maxErr = 0;
    for (let t = 50; t < 350; t += 0.37) {
      interpComplex(re, im, 0, t, o);
      maxErr = Math.max(maxErr, Math.hypot(o.re - Math.cos((2 * Math.PI * f * t) / fs), o.im - Math.sin((2 * Math.PI * f * t) / fs)));
    }
    expect(20 * Math.log10(maxErr)).toBeLessThan(-50);
  });
});

describe('spectrum', () => {
  it('reads a full-scale sine as 0 dBFS at the right frequency', () => {
    const fs = 48000;
    const x = tone(17500, 1, fs, 1);
    const s = welch(x, fs, 4096);
    const p = peakIn(s, 17000, 18000);
    expect(Math.abs(p.db)).toBeLessThan(0.2);
    expect(Math.abs(p.freq - 17500)).toBeLessThan(2);
    expect(goertzelAmp(x, fs, 17500)).toBeCloseTo(1, 2);
  });
});

import { markerWave, findMarkers } from './marker.ts';

describe('marker', () => {
  it('finds markers at the right time at low SNR, any sample rate', () => {
    for (const fs of [44100, 48000]) {
      const rng = new Rng(5);
      const x = new Float32Array(3 * fs);
      const mw = markerWave(fs, undefined, 0.1);
      const t1 = 0.4321, t2 = 1.9876;
      x.set(mw, Math.round(t1 * fs));
      x.set(mw, Math.round(t2 * fs));
      // white noise with in-band (1.3 kHz) SNR of about -5 dB
      const sigP = 0.1 ** 2 / 2;
      const sigma = Math.sqrt((sigP / Math.pow(10, -5 / 10)) * (fs / 2) / 1300);
      for (let i = 0; i < x.length; i++) x[i] += sigma * rng.gauss();
      const hits = findMarkers(x, fs);
      expect(hits.length).toBe(2);
      expect(Math.abs(hits[0].time - t1)).toBeLessThan(0.0005);
      expect(Math.abs(hits[1].time - t2)).toBeLessThan(0.0005);
    }
  });
  it('does not trigger on noise or on a steady in-band tone', () => {
    const fs = 48000;
    const rng = new Rng(9);
    const x = new Float32Array(5 * fs);
    for (let i = 0; i < x.length; i++) x[i] = 0.1 * rng.gauss() + 0.3 * Math.cos((2 * Math.PI * 17750 * i) / fs);
    expect(findMarkers(x, fs).length).toBe(0);
  });
});
