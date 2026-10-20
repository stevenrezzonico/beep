import { describe, expect, it } from 'vitest';
import { allCandidates, hardBits } from './index.ts';
import { Rng } from '../../src/dsp/prng.ts';
import { applyChannel } from '../../sim/channel.ts';

describe('modulation candidates', () => {
  for (const c of allCandidates()) {
    it(`${c.id} round-trips error-free at high SNR across 48k→44.1k`, () => {
      const rng = new Rng(42);
      const nbits = Math.max(64, Math.round(c.bitRate * 0.6));
      const bits = rng.bits(nbits);
      const x = c.modulate(bits, 48000);
      let pk = 0;
      for (const v of x) pk = Math.max(pk, Math.abs(v));
      expect(pk).toBeLessThanOrEqual(1.0001);
      const { y, t0 } = applyChannel(x, { fsTx: 48000, fsRx: 44100, snrDb: 30, leadSec: 0.1, tailSec: 0.1, seed: 3 });
      const got = hardBits(c.demodulate(y, 44100, t0, nbits));
      let errs = 0;
      for (let i = 0; i < nbits; i++) errs += got[i] ^ bits[i];
      expect(errs).toBe(0);
    });
  }
});
