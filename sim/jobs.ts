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

import { modulatePacket } from '../modem/tx.ts';
import { Receiver, softBits, type RxEvent, type SymbolResult } from '../modem/rx.ts';
import { Baseband } from '../modem/baseband.ts';
import { dechirpFft } from '../modem/css.ts';
import { bandInfo } from '../modem/band.ts';
import { decodePayload, payloadSymbolCount } from '../modem/frame.ts';
import { DEFAULT_CONFIG, type ModemConfig } from '../modem/profiles.ts';

export interface ModemPerArgs {
  profile: string;
  cond: string;
  snrs: number[]; // descending
  packets: number;
  payloadBytes: number;
  cfg?: Partial<ModemConfig>;
  fsTx: number;
  fsRx: number;
  /** stop after this many consecutive points with zero successes */
  stopAfterZero?: number;
}

export interface PerPoint {
  snr: number;
  sent: number;
  synced: number;
  headerOk: number;
  ok: number;
  /** Packets that passed CRC with wrong content — must be 0. */
  corrupt: number;
  per: number;
  meanSnrEst: number | null;
  meanAbsVelErr: number | null;
}

export function modemPer(a: ModemPerArgs): PerPoint[] {
  const cfg: ModemConfig = { ...DEFAULT_CONFIG, ...(a.cfg ?? {}) };
  const prof = cfg.profiles.find((p) => p.name === a.profile)!;
  const cond = allConditions().find((x) => x.id === a.cond)!;
  const out: PerPoint[] = [];
  let zeros = 0;
  for (const snr of a.snrs) {
    let synced = 0, headerOk = 0, ok = 0, corrupt = 0, snrSum = 0, velErr = 0;
    for (let k = 0; k < a.packets; k++) {
      const seed = hashSeed('modem', a.profile, a.cond, snr, k, JSON.stringify(a.cfg ?? {}));
      const rng = new Rng(seed);
      const data = rng.bytes(a.payloadBytes);
      const x = modulatePacket(data, prof, a.fsTx, cfg, { level: 0.5, padSec: 0 });
      const lead = 0.3 + rng.next() * 1.0;
      const chan = cond.make(seed, a.fsTx);
      const { y } = applyChannel(x, { fsTx: a.fsTx, fsRx: a.fsRx, snrDb: snr, txPeak: 0.5, leadSec: lead, tailSec: 0.5, seed, ...chan });
      const rx = new Receiver(a.fsRx, cfg);
      const ev: RxEvent[] = [];
      for (let i = 0; i < y.length; i += 4096) ev.push(...rx.push(y.subarray(i, i + 4096)));
      ev.push(...rx.flush());
      if (ev.some((e) => e.type === 'sync')) synced++;
      if (ev.some((e) => e.type === 'header')) headerOk++;
      const pk = ev.find((e) => e.type === 'packet' && e.ok) as Extract<RxEvent, { type: 'packet'; ok: true }> | undefined;
      if (pk) {
        const same = pk.data.length === data.length && pk.data.every((v, i) => v === data[i]);
        if (same) {
          ok++;
          snrSum += pk.diag.snrDb;
          // a receiver clock that runs fast by ppm compresses the time scale like receding motion
          const v = (chan.velocity ?? 0) - 343 * (chan.clockPpm ?? 0) * 1e-6;
          velErr += Math.abs(pk.diag.velocity - v);
        } else corrupt++;
      }
    }
    out.push({ snr, sent: a.packets, synced, headerOk, ok, corrupt, per: 1 - ok / a.packets, meanSnrEst: ok ? snrSum / ok : null, meanAbsVelErr: ok ? velErr / ok : null });
    if (ok === 0) {
      if (++zeros >= (a.stopAfterZero ?? 2)) break;
    } else zeros = 0;
  }
  return out;
}

export interface LossPoint {
  snr: number;
  sent: number;
  synced: number;
  headerOk: number;
  /** Full receiver: packets decoded correctly. */
  ok: number;
  /** Genie-timed payload decode of the same samples (true timing, time scale and carrier). */
  genieOk: number;
}

/**
 * Where a profile's packets are lost: the full receiver's sync, header and payload stages, next to a
 * genie-timed decode of the same payload samples with the receiver's own normalisation, soft
 * metric and decoder. The genie knows the payload start and the channel's (constant) time scale,
 * so it is valid for conditions without motion.
 */
export function modemLoss(a: ModemPerArgs): LossPoint[] {
  const cfg: ModemConfig = { ...DEFAULT_CONFIG, ...(a.cfg ?? {}) };
  const prof = cfg.profiles.find((p) => p.name === a.profile)!;
  const cond = allConditions().find((x) => x.id === a.cond)!;
  const b = bandInfo(cfg.band);
  const N = 1 << prof.sf;
  const h = { profile: prof.id, length: a.payloadBytes };
  const n = payloadSymbolCount(a.payloadBytes, prof.sf, prof.rate);
  const tPay = ((1 << cfg.sfPre) / b.bw) * (cfg.nUp + cfg.nDown + cfg.nHeader);
  const zr = new Float64Array(N), zi = new Float64Array(N), re = new Float64Array(N), im = new Float64Array(N);
  const out: LossPoint[] = [];
  for (const snr of a.snrs) {
    const pt: LossPoint = { snr, sent: a.packets, synced: 0, headerOk: 0, ok: 0, genieOk: 0 };
    for (let k = 0; k < a.packets; k++) {
      const seed = hashSeed('loss', a.profile, a.cond, snr, k);
      const rng = new Rng(seed);
      const data = rng.bytes(a.payloadBytes);
      const x = modulatePacket(data, prof, a.fsTx, cfg, { level: 0.5, padSec: 0 });
      const lead = 0.3 + rng.next() * 1.0;
      const chan = cond.make(seed, a.fsTx);
      const { y } = applyChannel(x, { fsTx: a.fsTx, fsRx: a.fsRx, snrDb: snr, txPeak: 0.5, leadSec: lead, tailSec: 0.5, seed, ...chan });
      const rx = new Receiver(a.fsRx, cfg);
      const ev: RxEvent[] = [];
      for (let i = 0; i < y.length; i += 4096) ev.push(...rx.push(y.subarray(i, i + 4096)));
      ev.push(...rx.flush());
      if (ev.some((e) => e.type === 'sync')) pt.synced++;
      if (ev.some((e) => e.type === 'header')) pt.headerOk++;
      const pk = ev.find((e) => e.type === 'packet' && e.ok) as Extract<RxEvent, { type: 'packet'; ok: true }> | undefined;
      if (pk && pk.data.every((v, i) => v === data[i])) pt.ok++;
      // genie: transmitter time t arrives at receiver time t/s (constant velocity and clock offset)
      const s = (1 + (chan.velocity ?? 0) / 343) / (1 + (chan.clockPpm ?? 0) * 1e-6);
      const t0 = Math.round(lead * a.fsRx) / a.fsRx;
      const Ts = N / b.bw / s;
      const cfoBins = b.fc * (s - 1) * Ts;
      const bb = Baseband.of(y, a.fsRx, cfg.band);
      const syms: SymbolResult[] = [];
      for (let m = 0; m < n; m++) {
        bb.sample(t0 + tPay / s + m * Ts, Ts / N, N, zr, zi);
        dechirpFft(zr, zi, prof.sf, 'up', re, im, cfoBins);
        const p = new Float64Array(N);
        let peak = 0;
        for (let i = 0; i < N; i++) {
          p[i] = re[i] * re[i] + im[i] * im[i];
          if (p[i] > p[peak]) peak = i;
        }
        // the receiver's normalisation: noise mean excluding the peak and its sidelobes
        let mu = 0;
        for (let i = 0; i < N; i++) mu += p[i];
        for (let d = -2; d <= 2; d++) mu -= p[(peak + d + N) % N];
        mu /= N - 5;
        for (let i = 0; i < N; i++) p[i] /= mu;
        syms.push({ power: p, peak, ratio: p[peak], frac: 0 });
      }
      const g = decodePayload(h, softBits(syms, prof.sf), prof.rate);
      if (g.data && g.data.every((v, i) => v === data[i])) pt.genieOk++;
    }
    out.push(pt);
  }
  return out;
}

export interface FalseAlarmArgs {
  seconds: number;
  fs: number;
  kind: 'white' | 'tone' | 'clicks';
  seed: number;
  cfg?: Partial<ModemConfig>;
}

/** Noise-only soak: count receiver events that should never happen without a transmitter. */
export function falseAlarms(a: FalseAlarmArgs): Record<string, number> {
  const cfg: ModemConfig = { ...DEFAULT_CONFIG, ...(a.cfg ?? {}) };
  const rx = new Receiver(a.fs, cfg);
  const rng = new Rng(a.seed);
  const counts: Record<string, number> = { detect: 0, sync: 0, header: 0, packet: 0 };
  const block = a.fs;
  const buf = new Float32Array(block);
  let phase = 0;
  for (let s = 0; s < a.seconds; s++) {
    for (let i = 0; i < block; i++) {
      let v = 0.05 * rng.gauss();
      if (a.kind === 'tone') {
        v += 0.2 * Math.cos(phase);
        phase += (2 * Math.PI * 17600) / a.fs;
      }
      if (a.kind === 'clicks' && rng.next() < 3 / a.fs) v += 0.8 * (rng.next() - 0.5);
      buf[i] = v;
    }
    for (const e of rx.push(buf)) if (e.type in counts) counts[e.type]++;
  }
  return counts;
}

import { cssCandidate } from '../modem/candidates/css.ts';
import { convEncode, viterbiDecode } from '../modem/fec/conv.ts';
import { rsEncode, rsDecode } from '../modem/fec/rs.ts';
import { hamming74Encode, hamming74Decode } from '../modem/fec/simple.ts';
import { interleave, deinterleave } from '../modem/fec/interleave.ts';
import { bytesToBits, bitsToBytes } from '../modem/fec/crc.ts';

export type FecScheme = 'none' | 'hamming74' | 'rs' | 'conv12' | 'conv12-noint' | 'conv23';

export interface FecPerArgs {
  scheme: FecScheme;
  sf: number;
  cond: string;
  snrs: number[];
  packets: number;
  payloadBytes: number;
}

/**
 * Packet error rate of a payload FEC scheme on genie-synchronised CSS (soft LLRs), so only the code
 * differs between schemes. RS is byte-oriented hard-decision (errors-only), shortened to the payload
 * with as many parity bytes as data bytes (rate ≈ 1/2, like the convolutional code).
 */
export function fecPer(a: FecPerArgs): PerPoint[] {
  const c = cssCandidate(a.sf);
  const cond = allConditions().find((x) => x.id === a.cond)!;
  const out: PerPoint[] = [];
  let zeros = 0;
  for (const snr of a.snrs) {
    let ok = 0;
    for (let k = 0; k < a.packets; k++) {
      const seed = hashSeed('fec', a.scheme, a.sf, a.cond, snr, k);
      const rng = new Rng(seed);
      const data = rng.bytes(a.payloadBytes);
      const bits = bytesToBits(data);
      let coded: Uint8Array;
      if (a.scheme === 'none') coded = bits;
      else if (a.scheme === 'hamming74') coded = interleave(hamming74Encode(bits));
      else if (a.scheme === 'rs') coded = bytesToBits(rsEncode(data, a.payloadBytes));
      else if (a.scheme === 'conv12') coded = interleave(convEncode(bits, '1/2'));
      else if (a.scheme === 'conv12-noint') coded = convEncode(bits, '1/2');
      else coded = interleave(convEncode(bits, '2/3'));
      const x = c.modulate(coded, 48000);
      const { y, t0 } = applyChannel(x, { fsTx: 48000, fsRx: 44100, snrDb: snr, txPeak: 1, leadSec: 0.1, tailSec: 0.1, seed, ...cond.make(seed, 48000) });
      const llr = c.demodulate(y, 44100, t0, coded.length);
      let got: Uint8Array | null;
      if (a.scheme === 'none') got = bitsToBytes(Array.from(llr, (v) => (v < 0 ? 1 : 0)));
      else if (a.scheme === 'hamming74') got = bitsToBytes(hamming74Decode(deinterleave(llr), bits.length));
      else if (a.scheme === 'rs') {
        const r = rsDecode(bitsToBytes(Array.from(llr, (v) => (v < 0 ? 1 : 0))), a.payloadBytes);
        got = r ? r.data : null;
      } else if (a.scheme === 'conv12') got = bitsToBytes(viterbiDecode(deinterleave(llr), bits.length, '1/2').bits);
      else if (a.scheme === 'conv12-noint') got = bitsToBytes(viterbiDecode(llr, bits.length, '1/2').bits);
      else got = bitsToBytes(viterbiDecode(deinterleave(llr), bits.length, '2/3').bits);
      if (got && got.length >= data.length && data.every((v, i) => v === got![i])) ok++;
    }
    out.push({ snr, sent: a.packets, synced: a.packets, headerOk: a.packets, ok, corrupt: 0, per: 1 - ok / a.packets, meanSnrEst: null, meanAbsVelErr: null });
    if (ok === 0) {
      if (++zeros >= 2) break;
    } else zeros = 0;
  }
  return out;
}
