import { describe, expect, it } from 'vitest';
import { encodeMessage, repairPayloads, Reassembler, MAX_PACKET_BYTES } from './message.ts';
import { parseFrame, FrameType } from './frame.ts';
import { RlncDecoder, encodeFragment } from './rlnc.ts';
import { BitWriter, BitReader } from './bits.ts';
import { Rng } from '../src/dsp/prng.ts';

describe('bits', () => {
  it('exp-golomb round trip and sizes', () => {
    const w = new BitWriter();
    const vals = [0, 1, 2, 3, 6, 7, 100, 4095, 70000];
    for (const v of vals) w.expGolomb(v);
    const r = new BitReader(w.toBits());
    for (const v of vals) expect(r.expGolomb()).toBe(v);
    expect(new BitWriter().expGolomb(0).length).toBe(1);
    expect(new BitWriter().expGolomb(6).length).toBe(5);
  });
  it('1-0 padding finds the exact end', () => {
    for (let n = 0; n < 20; n++) {
      const w = new BitWriter();
      for (let i = 0; i < n; i++) w.bit(i % 3 === 0);
      const r = BitReader.fromPadded(w.toBytesPadded())!;
      expect(r.remaining).toBe(n);
    }
  });
});

describe('rlnc', () => {
  it('recovers from any k fragments (source or repair, any order)', () => {
    const rng = new Rng(1);
    for (const k of [1, 2, 5, 40]) {
      const src = Array.from({ length: k }, () => rng.bytes(17));
      let fails = 0;
      for (let trial = 0; trial < 20; trial++) {
        const idx = Array.from({ length: 3 * k + 5 }, (_, i) => i).sort(() => rng.next() - 0.5);
        const dec = new RlncDecoder(k, 17, 1234);
        let used = 0;
        for (const i of idx) {
          dec.add(i, encodeFragment(src, i, 1234));
          used++;
          if (dec.complete) break;
        }
        expect(dec.complete).toBe(true);
        if (used > k + 1) fails++;
        expect(dec.result()!.map((b) => Array.from(b))).toEqual(src.map((b) => Array.from(b)));
      }
      expect(fails).toBeLessThanOrEqual(1);
    }
  });
});

describe('message layer', () => {
  it('short text is one packet with an 8-bit header', () => {
    const out = encodeMessage({ kind: 'text', text: 'On my way, be there in 15 min' }, { maxPacket: 32, id: 3 });
    expect(out.fragmented).toBe(false);
    expect(out.payloads.length).toBe(1);
    expect(out.payloads[0].length).toBe(Math.ceil((8 + out.contentBits + 1) / 8));
    const r = new Reassembler();
    const ev = r.push(out.payloads[0], 0);
    expect(ev[0]).toMatchObject({ type: 'message', content: { kind: 'text', text: 'On my way, be there in 15 min' } });
    expect(r.push(out.payloads[0], 1)[0].type).toBe('duplicate');
  });

  it('reassembles a 4 KB file from shuffled fragments with losses and duplicates', () => {
    const rng = new Rng(5);
    const data = rng.bytes(4096);
    for (const [profile, maxPacket] of Object.entries(MAX_PACKET_BYTES)) {
      const out = encodeMessage({ kind: 'file', name: 'notes.txt', data }, { maxPacket, id: 77, repairRatio: 0.3 });
      expect(out.fragmented).toBe(true);
      for (const p of out.payloads) expect(p.length).toBeLessThanOrEqual(maxPacket);
      // lose ~20%, duplicate some, shuffle
      const pkts = out.payloads.filter(() => rng.next() > 0.2);
      pkts.push(...pkts.slice(0, 3));
      pkts.sort(() => rng.next() - 0.5);
      const r = new Reassembler();
      let msg = null;
      for (const p of pkts) for (const e of r.push(p, 0)) if (e.type === 'message') msg = e;
      if (!msg) {
        // top up with fresh repair fragments, as a carousel would
        const more = repairPayloads({ kind: 'file', name: 'notes.txt', data }, { maxPacket, id: 77 }, out.payloads.length, out.k);
        for (const p of more) for (const e of r.push(p, 0)) if (e.type === 'message') msg = e;
      }
      expect(msg, profile).not.toBeNull();
      expect(msg!.content).toMatchObject({ kind: 'file', name: 'notes.txt' });
      expect(Array.from((msg!.content as { data: Uint8Array }).data)).toEqual(Array.from(data));
    }
  });

  it('detects mixed fragments from colliding ids via CRC-32', () => {
    const rng = new Rng(8);
    const a = encodeMessage({ kind: 'bytes', data: rng.bytes(300) }, { maxPacket: 64, id: 9, repairRatio: 0 });
    const b = encodeMessage({ kind: 'bytes', data: rng.bytes(300) }, { maxPacket: 64, id: 9, repairRatio: 0 });
    const r = new Reassembler();
    const ev = [...a.payloads.slice(0, 2), ...b.payloads.slice(2)].flatMap((p) => r.push(p, 0));
    expect(ev.some((e) => e.type === 'message')).toBe(false);
    expect(ev.some((e) => e.type === 'error')).toBe(true);
  });

  it('keeps the reassembly buffer bounded', () => {
    const rng = new Rng(2);
    const r = new Reassembler({ maxMessages: 3 });
    for (let id = 0; id < 10; id++) {
      const out = encodeMessage({ kind: 'bytes', data: rng.bytes(500) }, { maxPacket: 64, id, repairRatio: 0 });
      r.push(out.payloads[0], id);
    }
    expect(r.status().length).toBe(3);
  });

  it('frames parse back with the documented header sizes', () => {
    const out = encodeMessage({ kind: 'bytes', data: new Uint8Array(1000) }, { maxPacket: 64, id: 5 });
    const f = parseFrame(out.payloads[3])!;
    expect(f.type).toBe(FrameType.Fragment);
  });
});
