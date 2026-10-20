import { describe, expect, it } from 'vitest';
import { RxSession } from './session.ts';
import { planSend, PACKET_GAP } from './sender.ts';
import { modulatePacket } from '../modem/tx.ts';
import { DEFAULT_CONFIG, profileByName } from '../modem/profiles.ts';
import { applyChannel } from '../sim/channel.ts';
import { Rng } from '../src/dsp/prng.ts';

/** Render a send plan the way Transmission schedules it (packets back to back with gaps). */
function render(plan: ReturnType<typeof planSend>, fs: number, packets = plan.payloads): Float32Array {
  const parts = packets.map((p) => modulatePacket(p, plan.profile, fs, DEFAULT_CONFIG, { level: 1, padSec: 0.02 }));
  const gap = Math.round(PACKET_GAP * fs);
  const y = new Float32Array(parts.reduce((a, w) => a + w.length + gap, 0));
  let o = 0;
  for (const w of parts) {
    y.set(w, o);
    o += w.length + gap;
  }
  return y;
}

function receive(y: Float32Array, fs: number): RxSession {
  const s = new RxSession(fs);
  for (let i = 0; i < y.length; i += 2048) s.push(y.subarray(i, i + 2048));
  s.push(new Float32Array(fs * 2));
  return s;
}

describe('app pipeline (sender plan → channel → RxSession)', () => {
  it('delivers a short text message end to end', () => {
    const plan = planSend({ kind: 'text', text: 'Door code 2580, flat 3B' }, profileByName(DEFAULT_CONFIG, 'fast'), 5, 0);
    expect(plan.fragmented).toBe(false);
    const { y } = applyChannel(render(plan, 48000), { fsTx: 48000, fsRx: 44100, snrDb: 3, txPeak: 1, leadSec: 0.6, tailSec: 0.3, velocity: 0.2, seed: 1 });
    const s = receive(y, 44100);
    expect(s.messages.length).toBe(1);
    expect(s.messages[0].content).toEqual({ kind: 'text', text: 'Door code 2580, flat 3B' });
    expect(s.packets[0].ok).toBe(true);
    expect(s.counters.packetsFailed).toBe(0);
  });

  it('reassembles a fragmented file despite a lost packet, using a repair fragment', () => {
    const data = new Rng(3).bytes(500);
    const plan = planSend({ kind: 'file', name: 'a.bin', data }, profileByName(DEFAULT_CONFIG, 'fast'), 9, 0.25);
    expect(plan.fragmented).toBe(true);
    expect(plan.payloads.length).toBeGreaterThan(plan.k);
    // drop source fragment 1 entirely (as if a door slammed during it)
    const kept = plan.payloads.filter((_, i) => i !== 1);
    const { y } = applyChannel(render(plan, 48000, kept), { fsTx: 48000, fsRx: 48000, snrDb: 6, txPeak: 1, leadSec: 0.5, tailSec: 0.3, seed: 2 });
    const s = receive(y, 48000);
    expect(s.messages.length).toBe(1);
    const c = s.messages[0].content;
    expect(c.kind).toBe('file');
    if (c.kind === 'file') {
      expect(c.name).toBe('a.bin');
      expect(Array.from(c.data)).toEqual(Array.from(data));
    }
    expect(s.partials.size).toBe(0);
  });

  it('shows nothing (and no corrupt data) for a buried signal', () => {
    const plan = planSend({ kind: 'text', text: 'hello' }, profileByName(DEFAULT_CONFIG, 'fast'), 1, 0);
    const { y } = applyChannel(render(plan, 48000), { fsTx: 48000, fsRx: 44100, snrDb: -30, txPeak: 1, leadSec: 0.5, tailSec: 0.3, seed: 4 });
    const s = receive(y, 44100);
    expect(s.messages.length).toBe(0);
  });

  it('stays quiet on exact digital silence (muted/interrupted mic delivers zeros)', () => {
    const s = receive(new Float32Array(44100 * 6), 44100);
    expect(s.counters.detections).toBe(0);
    expect(s.signalDb).toBe(-Infinity);
  });
});
