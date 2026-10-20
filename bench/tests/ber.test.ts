import { describe, expect, it } from 'vitest';
import { berModem, berPayload, type BerRunOptions } from './ber.ts';
import { applyChannel } from '../../sim/channel.ts';

/** TX at 48 kHz, RX at 44.1 kHz through the simulator channel (peak-referenced SNR, 1.5 kHz band). */
function run(profile: string, o: BerRunOptions, snrDb: number, seed = 3) {
  const x = berModem.txSignal(48000, profile, o);
  const { y } = applyChannel(x, { fsTx: 48000, fsRx: 44100, snrDb, txPeak: 1, leadSec: 0.8, tailSec: 0.5, clockPpm: 40, seed });
  return berModem.analyze(y, 44100, profile, o);
}

describe('bench BER/PER mode', () => {
  it('lists modem profiles and candidates', () => {
    const ids = berModem.profiles().map((p) => p.id);
    expect(ids).toContain('modem:fast');
    expect(ids).toContain('modem:long-range');
    expect(ids).toContain('cand:css-sf7');
  });

  it('payloads carry their index and are reproducible from the seed', () => {
    const a = berPayload(5, 258, 16);
    expect([a[0], a[1]]).toEqual([1, 2]);
    expect(Array.from(berPayload(5, 258, 16))).toEqual(Array.from(a));
    expect(Array.from(berPayload(6, 258, 16))).not.toEqual(Array.from(a));
  });

  it('modem profiles: PER 0 at 5 dB, durations match the signal', () => {
    for (const [profile, packets] of [['modem:fast', 4], ['modem:balanced', 2]] as const) {
      const o = { packets, payloadBytes: 16, seed: 7 };
      expect(berModem.txSignal(48000, profile, o).length / 48000).toBeCloseTo(berModem.durationSec(profile, o), 2);
      const r = run(profile, o, 5);
      expect(r.packetsOk, profile).toBe(packets);
      expect(r.per).toBe(0);
      expect(r.bitErrors).toBe(0);
      expect(r.corrupt).toBe(0);
      expect(r.packets.every((p) => p.detected && p.crcOk)).toBe(true);
      expect(r.meanSnrDb).toBeGreaterThan(-5);
    }
  });

  it('modem: a buried signal reports lost packets, never corrupt successes', () => {
    const o = { packets: 3, payloadBytes: 16, seed: 2 };
    const r = run('modem:fast', o, -30);
    expect(r.packetsOk).toBe(0);
    expect(r.per).toBe(1);
    expect(r.corrupt).toBe(0);
  });

  it('candidates: BER 0 at 15 dB with per-burst marker resync', () => {
    for (const id of ['cand:css-sf7', 'cand:mfsk32', 'cand:bfsk100']) {
      const o = { packets: 4, payloadBytes: 8, seed: 1 };
      const r = run(id, o, 15);
      expect(r.bitsCompared, id).toBe(4 * 8 * 8);
      expect(r.ber, id).toBe(0);
      expect(r.per, id).toBe(0);
      expect(r.meanSnrDb, id).toBeGreaterThan(5);
    }
  });

  it('candidates: no marker fails clearly; a weak burst reports its errors', () => {
    const o = { packets: 2, payloadBytes: 8, seed: 1 };
    expect(() => run('cand:css-sf7', o, -40)).toThrow(/marker not found/i);
    // marker still found (1 s marker, ~31 dB matched-filter gain), payload weak: uncoded SF5 at −8 dB
    const r = run('cand:css-sf5', { packets: 8, payloadBytes: 8, seed: 4 }, -8);
    // and the long marker still finds bursts where uncoded SF8 is just above its threshold
    const r8 = run('cand:css-sf8', { packets: 2, payloadBytes: 8, seed: 4 }, -14);
    expect(r8.packetsDetected).toBe(2);
    expect(r.ber).toBeGreaterThan(0.005);
    expect(r.per).toBeGreaterThan(0.2);
  });
});
