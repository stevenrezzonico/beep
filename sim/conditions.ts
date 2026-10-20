import { syntheticIr, prepareMeasuredIr, type ChannelOptions } from './channel.ts';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Named channel conditions used for every BER/PER curve. Synthetic rooms stand in until the bench
 * has measured impulse responses; any `sim/ir/*.json` file (bench export: {fs, ir, meta}) is
 * added automatically as an extra condition `ir:<name>`.
 *
 * Numbers and where they come from:
 *  - rt60 0.3 s / 0.6 s: typical furnished room / bare room at high frequencies (high-frequency
 *    RT60 is shorter than mid-band because of air and soft-furnishing absorption). Replace with
 *    bench echo-test values.
 *  - DRR +6 dB ≈ 1 m in a living room, −3 dB ≈ beyond the critical distance (several metres).
 *  - 0.5 m/s ≈ walking slowly towards the other device (≈26 Hz at 17.75 kHz); ±0.1 m/s sway
 *    (±3 cm) ≈ a phone held in the hand; ±0.3 m/s (±10 cm every 2 s) ≈ a phone being waved.
 *  - 50 ppm: typical consumer audio clock mismatch.
 *  - k3 = 0.05, −6 dB tilt: a mildly overdriven phone speaker whose response falls off towards
 *    18.5 kHz.
 */
export interface Condition {
  id: string;
  label: string;
  make(seed: number, fsTx: number): Partial<ChannelOptions>;
}

const roomCache = new Map<string, Float32Array>();
function room(rt60: number, drrDb: number, fs: number, seed: number): Float32Array {
  const key = `${rt60}/${drrDb}/${fs}/${seed % 4}`;
  let h = roomCache.get(key);
  if (!h) {
    h = syntheticIr({ fs, rt60, drrDb, seed: 100 + (seed % 4) });
    roomCache.set(key, h);
  }
  return h;
}

export const CONDITIONS: Condition[] = [
  { id: 'awgn', label: 'AWGN only (48k→44.1k resample)', make: () => ({}) },
  {
    id: 'room-near',
    label: 'Room RT60 0.3 s, DRR +6 dB, speaker k3/tilt',
    make: (s, fs) => ({ ir: room(0.3, 6, fs, s), speakerK3: 0.05, tiltDb: -6, clockPpm: 50 }),
  },
  {
    id: 'room-far',
    label: 'Room RT60 0.6 s, DRR −3 dB, speaker k3/tilt',
    make: (s, fs) => ({ ir: room(0.6, -3, fs, s), speakerK3: 0.05, tiltDb: -6, clockPpm: 50 }),
  },
  { id: 'doppler', label: 'Constant 0.5 m/s (≈26 Hz) + 50 ppm', make: () => ({ velocity: 0.5, clockPpm: 50 }) },
  {
    id: 'hand-held',
    label: 'Hand-held sway ±0.1 m/s (2 s period) in RT60 0.3 s room',
    make: (s, fs) => ({ ir: room(0.3, 6, fs, s), motion: { peakVel: 0.1, period: 2 }, clockPpm: 50 }),
  },
  {
    id: 'motion-room',
    label: 'Waving ±0.3 m/s (2 s period) in RT60 0.3 s room',
    make: (s, fs) => ({ ir: room(0.3, 6, fs, s), motion: { peakVel: 0.3, period: 2 }, clockPpm: 50 }),
  },
];

/** Bench-measured IRs dropped into sim/ir/ become extra conditions. */
export function measuredConditions(dir = join(import.meta.dirname, 'ir')): Condition[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { fs: number; ir: number[]; meta?: unknown };
      const cache = new Map<number, Float32Array>();
      return {
        id: `ir:${f.replace(/\.json$/, '')}`,
        label: `Measured IR ${f}`,
        make: (_s: number, fs: number) => {
          let h = cache.get(fs);
          if (!h) cache.set(fs, (h = prepareMeasuredIr(m, fs)));
          return { ir: h, clockPpm: 50 };
        },
      };
    });
}

export function allConditions(): Condition[] {
  return [...CONDITIONS, ...measuredConditions()];
}
