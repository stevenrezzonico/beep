import { describe, expect, it } from 'vitest';
import { convEncode, viterbiDecode, codedLength, type CodeRate, type Termination } from './conv.ts';
import { rsEncode, rsDecode } from './rs.ts';
import { hamming74Encode, hamming74Decode } from './simple.ts';
import { crc16, crc8, bytesToBits } from './crc.ts';
import { interleave, deinterleave } from './interleave.ts';
import { Rng } from '../../src/dsp/prng.ts';

const toLlr = (bits: Uint8Array, rng: Rng, sigma: number) => Float64Array.from(bits, (b) => (b ? -1 : 1) * 2 + sigma * rng.gauss());

describe('convolutional code', () => {
  for (const rate of ['1/2', '2/3', '3/4'] as CodeRate[]) {
    for (const term of ['zero', 'tailbiting'] as Termination[]) {
      it(`round-trips noiselessly (${rate}, ${term})`, () => {
        const rng = new Rng(1);
        for (const n of [16, 37, 200]) {
          const d = rng.bits(n);
          const c = convEncode(d, rate, term);
          expect(c.length).toBe(codedLength(n, rate, term));
          const r = viterbiDecode(Float64Array.from(c, (b) => (b ? -1 : 1)), n, rate, term);
          expect(Array.from(r.bits)).toEqual(Array.from(d));
        }
      });
    }
  }
  it('corrects scattered errors (r=1/2)', () => {
    const rng = new Rng(2);
    const d = rng.bits(120);
    const c = convEncode(d);
    const llr = Float64Array.from(c, (b) => (b ? -1 : 1));
    for (const i of [5, 30, 60, 95, 140, 200]) llr[i] = -llr[i];
    expect(Array.from(viterbiDecode(llr, 120).bits)).toEqual(Array.from(d));
  });
  it('gains several dB over uncoded in AWGN', () => {
    const rng = new Rng(3);
    let errC = 0, errU = 0, nb = 0;
    const sigma = 2 / Math.sqrt(Math.pow(10, 4 / 10)); // amplitude 2, Eb/N0 = 4 dB at r=1/2
    for (let f = 0; f < 50; f++) {
      const d = rng.bits(200);
      const c = convEncode(d);
      const r = viterbiDecode(toLlr(c, rng, sigma), 200);
      for (let i = 0; i < 200; i++) errC += r.bits[i] ^ d[i];
      const u = toLlr(d, rng, sigma / Math.SQRT2);
      for (let i = 0; i < 200; i++) errU += (u[i] < 0 ? 1 : 0) ^ d[i];
      nb += 200;
    }
    expect(errC / nb).toBeLessThan(errU / nb / 5);
  });
});

describe('reed-solomon', () => {
  it('corrects up to nsym/2 errors and nsym erasures in shortened blocks', () => {
    const rng = new Rng(4);
    for (const [k, nsym] of [[20, 8], [100, 16], [223, 32]]) {
      const d = rng.bytes(k);
      const c = rsEncode(d, nsym);
      const e = Uint8Array.from(c);
      const pos = new Set<number>();
      while (pos.size < nsym / 2) pos.add(rng.int(c.length));
      for (const p of pos) e[p] ^= 1 + rng.int(255);
      const r = rsDecode(e, nsym);
      expect(r).not.toBeNull();
      expect(Array.from(r!.data)).toEqual(Array.from(d));
      const er = Uint8Array.from(c);
      const epos: number[] = [];
      while (epos.length < nsym) {
        const p = rng.int(c.length);
        if (!epos.includes(p)) epos.push(p);
      }
      for (const p of epos) er[p] = rng.int(256);
      const r2 = rsDecode(er, nsym, epos);
      expect(r2).not.toBeNull();
      expect(Array.from(r2!.data)).toEqual(Array.from(d));
    }
  });
  it('reports failure beyond capability rather than miscorrecting silently (mostly)', () => {
    const rng = new Rng(5);
    let fail = 0;
    for (let t = 0; t < 50; t++) {
      const c = rsEncode(rng.bytes(40), 8);
      for (let i = 0; i < 10; i++) c[rng.int(c.length)] ^= 1 + rng.int(255);
      if (rsDecode(c, 8) === null) fail++;
    }
    expect(fail).toBeGreaterThan(40);
  });
});

describe('hamming / crc / interleave', () => {
  it('hamming(7,4) corrects one error per block', () => {
    const d = new Rng(6).bits(40);
    const c = hamming74Encode(d);
    const llr = Float64Array.from(c, (b) => (b ? -1 : 1));
    for (let i = 0; i < llr.length; i += 7) llr[i + (i % 5)] *= -1;
    expect(Array.from(hamming74Decode(llr, 40))).toEqual(Array.from(d));
  });
  it('crc check values', () => {
    const ascii = bytesToBits(new TextEncoder().encode('123456789'));
    expect(crc16(ascii)).toBe(0x29b1); // CRC-16/CCITT-FALSE
    expect(crc8(ascii)).toBe(0xf4); // CRC-8/SMBUS
  });
  it('interleave inverts', () => {
    const x = new Rng(7).bits(333);
    expect(Array.from(deinterleave(interleave(x)))).toEqual(Array.from(x));
  });
});
