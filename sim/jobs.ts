import { candidateById, hardBits } from '../modem/candidates/index.ts';
import { applyChannel } from './channel.ts';
import { allConditions } from './conditions.ts';
import { Rng } from '../src/dsp/prng.ts';

export interface BerPoint {
  snr: number;
  bits: number;
  errors: number;
  ber: number;
}

export interface CandidateBerArgs {
  cand: string;
  cond: string;
  snrs: number[]; // descending
  budgetSec: number; // max simulated air time per SNR point
  minErrors: number;
  fsTx: number;
  fsRx: number;
}

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const p of parts) for (const ch of String(p)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Uncoded BER of one candidate on one condition across an SNR sweep (stops once BER ≥ 0.3 twice). */
export function candidateBer(a: CandidateBerArgs): BerPoint[] {
  const c = candidateById(a.cand);
  const cond = allConditions().find((x) => x.id === a.cond)!;
  const out: BerPoint[] = [];
  let bad = 0;
  for (const snr of a.snrs) {
    let bits = 0, errors = 0, air = 0, frame = 0;
    while (air < a.budgetSec && (errors < a.minErrors || bits < 2000)) {
      const seed = hashSeed(a.cand, a.cond, snr, frame++);
      const rng = new Rng(seed);
      const nbits = Math.max(48, Math.round(c.bitRate * 1.0));
      const tx = rng.bits(nbits);
      const x = c.modulate(tx, a.fsTx);
      const lead = 0.05 + 0.1 * rng.next();
      const { y, t0 } = applyChannel(x, { fsTx: a.fsTx, fsRx: a.fsRx, snrDb: snr, txPeak: 1, leadSec: lead, tailSec: 0.1, seed, ...cond.make(seed, a.fsTx) });
      const rx = hardBits(c.demodulate(y, a.fsRx, t0, nbits));
      for (let i = 0; i < nbits; i++) errors += rx[i] ^ tx[i];
      bits += nbits;
      air += x.length / a.fsTx;
    }
    const ber = errors / bits;
    out.push({ snr, bits, errors, ber });
    if (ber >= 0.3) {
      if (++bad >= 2) break;
    } else bad = 0;
  }
  return out;
}
