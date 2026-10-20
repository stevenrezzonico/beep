import { describe, expect, it } from 'vitest';
import { modulatePacket } from './tx.ts';
import { Receiver, fracPeak, type RxEvent } from './rx.ts';
import { DEFAULT_CONFIG, profileByName, PROFILES } from './profiles.ts';
import { applyChannel } from '../sim/channel.ts';
import { Rng } from '../src/dsp/prng.ts';
import { fft } from '../src/dsp/fft.ts';

function receive(y: Float32Array, fs: number, chunk = 4096): RxEvent[] {
  const rx = new Receiver(fs);
  const ev: RxEvent[] = [];
  for (let i = 0; i < y.length; i += chunk) ev.push(...rx.push(y.subarray(i, i + chunk)));
  ev.push(...rx.flush());
  return ev;
}

describe('fracPeak', () => {
  it('estimates the fractional bin of a complex tone', () => {
    const N = 128;
    for (const f of [10.0, 10.2, 10.45, 9.7, 3.33]) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let k = 0; k < N; k++) { re[k] = Math.cos((2 * Math.PI * f * k) / N); im[k] = Math.sin((2 * Math.PI * f * k) / N); }
      fft(re, im);
      const b = Math.round(f);
      expect(Math.abs(b + fracPeak(re, im, b) - f)).toBeLessThan(0.06);
    }
  });
});

describe('modem round trip', () => {
  for (const p of PROFILES) {
    it(`decodes a packet (${p.name}) at 48k→44.1k with 0.3 m/s and 50 ppm`, () => {
      const rng = new Rng(7);
      const data = rng.bytes(24);
      const x = modulatePacket(data, p, 48000);
      const { y } = applyChannel(x, { fsTx: 48000, fsRx: 44100, snrDb: 10, txPeak: 0.5, leadSec: 0.37, tailSec: 0.3, velocity: 0.3, clockPpm: 50, seed: 2 });
      const ev = receive(y, 44100);
      const pk = ev.filter((e) => e.type === 'packet');
      expect(pk.length).toBe(1);
      const e = pk[0] as Extract<RxEvent, { type: 'packet' }>;
      expect(e.ok).toBe(true);
      expect(Array.from(e.data!)).toEqual(Array.from(data));
      expect(Math.abs(e.diag.velocity - 0.3 - 343 * 50e-6)).toBeLessThan(0.08);
    });
  }

  it('gives identical events for any chunking (deterministic detection)', () => {
    const rng = new Rng(9);
    for (const name of ['fast', 'balanced']) {
      const x = modulatePacket(rng.bytes(10), profileByName(DEFAULT_CONFIG, name), 48000);
      const { y } = applyChannel(x, { fsTx: 48000, fsRx: 44100, snrDb: -3, txPeak: 0.5, leadSec: 0.5, tailSec: 0.2, velocity: 0.4, clockPpm: -80, seed: 4 });
      const ref = JSON.stringify(receive(y, 44100, y.length));
      expect(ref).toContain('"ok":true');
      for (const chunk of [37, 128, 1000, 4096, 8191]) expect(JSON.stringify(receive(y, 44100, chunk))).toBe(ref);
    }
  });

  it('stays silent on noise only', () => {
    const rng = new Rng(3);
    const y = new Float32Array(44100 * 20);
    for (let i = 0; i < y.length; i++) y[i] = 0.1 * rng.gauss();
    const ev = receive(y, 44100);
    expect(ev.filter((e) => e.type === 'packet').length).toBe(0);
  });
});
