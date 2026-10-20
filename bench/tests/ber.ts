import { modulatePacket, airTime } from '../../modem/tx.ts';
import { Receiver, type RxEvent, type PacketDiag } from '../../modem/rx.ts';
import { DEFAULT_CONFIG, PROFILES, describe, profileByName } from '../../modem/profiles.ts';
import { allCandidates, candidateById, hardBits } from '../../modem/candidates/index.ts';
import { Rng } from '../../src/dsp/prng.ts';
import { vMarkerWave, findVMarkers, V_MARKER } from './vmarker.ts';
import { welch, bandPowerDb } from '../../src/dsp/spectrum.ts';
import { POST_MARKER_GAP, MarkerNotFound, median } from './common.ts';

/**
 * Modem BER/PER mode. Two kinds of "profile" share the bench UI:
 *  - `modem:<name>`: the real modem (own preamble, sync, FEC, CRC). Each packet carries its index
 *    in the first two bytes and a pseudo-random body from (seed, index), so the receiver
 *    regenerates every payload and lost packets never shift the comparison. Reported: PER,
 *    residual BER of CRC-passed packets (must be 0 — anything else is silent corruption) and the
 *    raw channel BER estimated from the bits the FEC corrected.
 *  - `cand:<id>`: an uncoded modulation candidate, for comparing modulations on real devices.
 *    The bits go out in bursts of ≤ CAND_BURST_SEC, each preceded by a long V-chirp marker
 *    (vmarker.ts: detects down to ≈ −15 dB, below the slow candidates' thresholds)
 *    (genie timing, re-synchronised per burst so clock drift between devices does not
 *    accumulate); reported: raw BER, and PER over chunks of `payloadBytes`.
 *
 * Contract:
 *  - The payload is pseudo-random from `seed`, so the receiver regenerates it and compares bits
 *    without any side channel.
 *  - `txSignal` is self-contained at amplitude ≤ 1; the bench applies the TX gain.
 *  - `analyze` is deterministic for a given recording.
 */
export interface BerProfile {
  id: string;
  label: string;
  /** Raw/net bit rate for display, bits/s. */
  rawBps?: number;
  netBps?: number;
}

export interface BerRunOptions {
  packets: number;
  payloadBytes: number;
  seed: number;
}

export interface BerPacketResult {
  index: number;
  detected: boolean;
  crcOk: boolean;
  bitErrors: number;
  bits: number;
  snrDb?: number;
  timingOffsetSec?: number;
  freqOffsetHz?: number;
  velocity?: number;
  correctedSymbols?: number;
  correctedBits?: number;
  codedBits?: number;
}

export interface BerResult {
  test: 'ber';
  profile: string;
  fs: number;
  packetsSent: number;
  packetsDetected: number;
  packetsOk: number;
  /** Bit errors among compared bits (modem: CRC-passed packets only, so this must stay 0). */
  bitErrors: number;
  bitsCompared: number;
  ber: number;
  per: number;
  /** Modem only: channel BER before FEC, from bits the decoder corrected (decoded packets). */
  rawBer?: number;
  /** CRC-passed packets whose content was wrong — silent corruption, must be 0. */
  corrupt?: number;
  meanSnrDb?: number;
  packets: BerPacketResult[];
}

export interface BerModem {
  profiles(): BerProfile[];
  /** Seconds of audio `txSignal` produces for these options (sizes the RX recording). */
  durationSec(profileId: string, o: BerRunOptions): number;
  txSignal(fs: number, profileId: string, o: BerRunOptions): Float32Array;
  analyze(rec: Float32Array, fs: number, profileId: string, o: BerRunOptions): BerResult;
}

export const BER_DEFAULTS: BerRunOptions = { packets: 10, payloadBytes: 16, seed: 1 };

/** Silence between modem packets: the receiver needs no gap, but a short one keeps packets apart on a spectrogram. */
const PACKET_GAP = 0.25;
/** Lead-in before the first packet so the receiver's filters settle on noise first. */
const LEAD = 0.3;
/** Longest uncoded burst between markers: 50 ppm clock mismatch drifts only 0.15 ms over 3 s. */
const CAND_BURST_SEC = 3;
/** Smallest index field + body: two bytes of index, at least one byte of PRBS. */
const MIN_PAYLOAD = 3;

// ---------------------------------------------------------------- payloads

/** Payload of packet `index`: big-endian index in bytes 0–1, PRBS from (seed, index) after. */
export function berPayload(seed: number, index: number, bytes: number): Uint8Array {
  const n = Math.max(MIN_PAYLOAD, Math.min(256, bytes));
  const p = new Rng((seed * 0x9e3779b1) ^ (index * 0x85ebca6b) ^ 0x1234567).bytes(n);
  p[0] = (index >> 8) & 0xff;
  p[1] = index & 0xff;
  return p;
}

function popcount8(v: number): number {
  v = v - ((v >> 1) & 0x55);
  v = (v & 0x33) + ((v >> 2) & 0x33);
  return (v + (v >> 4)) & 0x0f;
}

function modemProfile(id: string) {
  return profileByName(DEFAULT_CONFIG, id.slice('modem:'.length));
}

// ---------------------------------------------------------------- modem profiles

function modemLayout(profileId: string, o: BerRunOptions): { starts: number[]; total: number } {
  const p = modemProfile(profileId);
  const bytes = Math.max(MIN_PAYLOAD, Math.min(256, o.payloadBytes));
  const dur = airTime(bytes, p);
  const starts: number[] = [];
  let t = LEAD;
  for (let i = 0; i < o.packets; i++) {
    starts.push(t);
    t += dur + PACKET_GAP;
  }
  return { starts, total: t + 0.3 };
}

function modemTx(fs: number, profileId: string, o: BerRunOptions): Float32Array {
  const p = modemProfile(profileId);
  const { starts, total } = modemLayout(profileId, o);
  const y = new Float32Array(Math.ceil(total * fs));
  for (let i = 0; i < o.packets; i++) {
    const w = modulatePacket(berPayload(o.seed, i, o.payloadBytes), p, fs, DEFAULT_CONFIG, { level: 1, padSec: 0 });
    y.set(w.subarray(0, Math.min(w.length, y.length - Math.round(starts[i] * fs))), Math.round(starts[i] * fs));
  }
  return y;
}

function modemAnalyze(rec: Float32Array, fs: number, profileId: string, o: BerRunOptions): BerResult {
  const rx = new Receiver(fs, DEFAULT_CONFIG);
  const ev: RxEvent[] = [];
  const CHUNK = 4096; // like a mic stream; the receiver is chunk-invariant anyway
  for (let i = 0; i < rec.length; i += CHUNK) ev.push(...rx.push(rec.subarray(i, i + CHUNK)));
  ev.push(...rx.flush());
  const bytes = Math.max(MIN_PAYLOAD, Math.min(256, o.payloadBytes));
  const { starts } = modemLayout(profileId, o);
  const packets: BerPacketResult[] = Array.from({ length: o.packets }, (_, index) => ({ index, detected: false, crcOk: false, bitErrors: 0, bits: 0 }));
  const pkts = ev.filter((e): e is Extract<RxEvent, { type: 'packet' }> => e.type === 'packet');
  // Map receiver sync times to transmitted packet indices: decoded packets carry their index, which
  // pins the transmit schedule to the receiver clock; failed packets are then placed by timing.
  const offsets: number[] = [];
  for (const e of pkts) if (e.ok && e.data.length >= 2) {
    const idx = (e.data[0] << 8) | e.data[1];
    if (idx < o.packets) offsets.push(e.diag.syncTime - starts[idx]);
  }
  const offset = offsets.length ? median(offsets) : null;
  const indexOf = (syncTime: number, fallback: number): number => {
    if (offset === null) return fallback;
    let best = 0;
    for (let i = 1; i < starts.length; i++) if (Math.abs(syncTime - offset - starts[i]) < Math.abs(syncTime - offset - starts[best])) best = i;
    return best;
  };
  let corrupt = 0, bitErrors = 0, bitsCompared = 0, corrBits = 0, codedBits = 0;
  const snrs: number[] = [];
  pkts.forEach((e, order) => {
    const d: PacketDiag = e.diag;
    let idx = e.ok && e.data.length >= 2 ? (e.data[0] << 8) | e.data[1] : indexOf(d.syncTime, order);
    if (idx >= o.packets) idx = indexOf(d.syncTime, order);
    const r = packets[Math.min(idx, o.packets - 1)];
    r.detected = true;
    r.snrDb = d.snrDb;
    r.freqOffsetHz = d.cfoHz;
    r.velocity = d.velocity;
    r.timingOffsetSec = offset === null ? undefined : d.syncTime - offset - starts[r.index];
    r.correctedSymbols = d.symbolErrors;
    r.correctedBits = d.correctedBits;
    r.codedBits = d.codedBits;
    if (!e.ok) return;
    const ref = berPayload(o.seed, r.index, bytes);
    let errs = 0;
    for (let i = 0; i < ref.length; i++) errs += popcount8(ref[i] ^ (e.data[i] ?? 0));
    if (e.data.length !== ref.length) errs += 8 * Math.abs(e.data.length - ref.length);
    if (errs) corrupt++;
    r.crcOk = true;
    r.bitErrors = errs;
    r.bits = 8 * ref.length;
    bitErrors += errs;
    bitsCompared += r.bits;
    corrBits += d.correctedBits;
    codedBits += d.codedBits;
    snrs.push(d.snrDb);
  });
  // Detection also counts packets whose header was found but whose payload never completed.
  const headerTimes = ev.filter((e): e is Extract<RxEvent, { type: 'header' }> => e.type === 'header').map((e) => e.time);
  for (const t of headerTimes) if (offset !== null) packets[indexOf(t, 0)].detected = true;
  const ok = packets.filter((p) => p.crcOk && p.bitErrors === 0).length;
  return {
    test: 'ber',
    profile: profileId,
    fs,
    packetsSent: o.packets,
    packetsDetected: packets.filter((p) => p.detected).length,
    packetsOk: ok,
    bitErrors,
    bitsCompared,
    ber: bitsCompared ? bitErrors / bitsCompared : NaN,
    per: 1 - ok / o.packets,
    rawBer: codedBits ? corrBits / codedBits : undefined,
    corrupt,
    meanSnrDb: snrs.length ? 10 * Math.log10(snrs.reduce((a, s) => a + 10 ** (s / 10), 0) / snrs.length) : undefined,
    packets,
  };
}

// ---------------------------------------------------------------- uncoded candidates

interface CandLayout {
  bursts: { start: number; bits: number; offset: number }[];
  total: number;
  nbits: number;
}

function candLayout(profileId: string, o: BerRunOptions): CandLayout {
  const c = candidateById(profileId.slice('cand:'.length));
  const nbits = o.packets * Math.max(1, o.payloadBytes) * 8;
  const per = Math.max(32, Math.floor(c.bitRate * CAND_BURST_SEC));
  const bursts: CandLayout['bursts'] = [];
  let t = LEAD;
  for (let off = 0; off < nbits; off += per) {
    const bits = Math.min(per, nbits - off);
    bursts.push({ start: t, bits, offset: off });
    // marker, gap, payload (+ modulator padding/ramps ≈ 2 symbol-lengths margin), echo gap
    t += V_MARKER.dur + POST_MARKER_GAP + bits / c.bitRate + 0.1 + 0.3;
  }
  return { bursts, total: t + 0.2, nbits };
}

function candBits(seed: number, n: number): Uint8Array {
  return new Rng(seed ^ 0x5bd1e995).bits(n);
}

function candTx(fs: number, profileId: string, o: BerRunOptions): Float32Array {
  const c = candidateById(profileId.slice('cand:'.length));
  const L = candLayout(profileId, o);
  const all = candBits(o.seed, L.nbits);
  const y = new Float32Array(Math.ceil(L.total * fs));
  const mk = vMarkerWave(fs);
  for (const b of L.bursts) {
    const i0 = Math.round(b.start * fs);
    y.set(mk, i0);
    const w = c.modulate(all.subarray(b.offset, b.offset + b.bits), fs);
    const i1 = Math.round((b.start + V_MARKER.dur + POST_MARKER_GAP) * fs);
    y.set(w.subarray(0, Math.max(0, Math.min(w.length, y.length - i1))), i1);
  }
  return y;
}

function candAnalyze(rec: Float32Array, fs: number, profileId: string, o: BerRunOptions): BerResult {
  const c = candidateById(profileId.slice('cand:'.length));
  const L = candLayout(profileId, o);
  const hits = findVMarkers(rec, fs);
  if (!hits.length) throw new MarkerNotFound();
  const ref = candBits(o.seed, L.nbits);
  const got = new Uint8Array(L.nbits).fill(2); // 2 = burst not received
  // anchor the burst schedule on the receiver clock with the offset most marker hits agree on,
  // so a missed first burst or a stray hit cannot shift everything
  let t0 = hits[0].time - L.bursts[0].start, bestCount = 0;
  for (const h of hits) {
    for (const b of L.bursts) {
      const off = h.time - b.start;
      const count = L.bursts.filter((c) => hits.some((x) => Math.abs(x.time - off - c.start) < 0.05)).length;
      if (count > bestCount) {
        bestCount = count;
        t0 = off;
      }
    }
  }
  const snrs: number[] = [];
  // noise reference: whatever was recorded before the first marker (if long enough)
  const pre = rec.subarray(0, Math.max(0, Math.floor((hits[0].time - 0.05) * fs)));
  const noiseDb = pre.length > 0.3 * fs ? bandPowerDb(welch(pre, fs, 2048), 17000, 18500) : NaN;
  for (const b of L.bursts) {
    // re-locate each burst's marker near where the schedule puts it (clock drift, false hits)
    const want = t0 + b.start;
    const near = hits.filter((h) => Math.abs(h.time - want) < 0.05).sort((x, y) => Math.abs(x.time - want) - Math.abs(y.time - want))[0];
    if (!near) continue;
    const ts = near.time + V_MARKER.dur + POST_MARKER_GAP;
    // demodulate only this burst's stretch of the recording (the candidates downconvert all they get)
    const a = Math.max(0, Math.floor((ts - 0.2) * fs));
    const z = Math.min(rec.length, Math.ceil((ts + b.bits / c.bitRate + 0.5) * fs));
    const h = hardBits(c.demodulate(rec.subarray(a, z), fs, ts - a / fs, b.bits));
    got.set(h, b.offset);
    if (Number.isFinite(noiseDb)) {
      const seg = rec.subarray(Math.round(ts * fs), Math.min(rec.length, Math.round((ts + b.bits / c.bitRate) * fs)));
      if (seg.length > 2048) {
        const s = 10 ** (bandPowerDb(welch(seg, fs, 2048), 17000, 18500) / 10) - 10 ** (noiseDb / 10);
        if (s > 0) snrs.push(10 * Math.log10(s) - noiseDb);
      }
    }
  }
  const chunk = Math.max(1, o.payloadBytes) * 8;
  const packets: BerPacketResult[] = [];
  let bitErrors = 0, bitsCompared = 0;
  for (let i = 0; i < o.packets; i++) {
    let errs = 0, bits = 0, received = true;
    for (let k = i * chunk; k < (i + 1) * chunk; k++) {
      if (got[k] === 2) { received = false; continue; }
      bits++;
      errs += got[k] ^ ref[k];
    }
    bitErrors += errs;
    bitsCompared += bits;
    packets.push({ index: i, detected: received, crcOk: received && errs === 0, bitErrors: errs, bits });
  }
  const ok = packets.filter((p) => p.crcOk).length;
  return {
    test: 'ber',
    profile: profileId,
    fs,
    packetsSent: o.packets,
    packetsDetected: packets.filter((p) => p.detected).length,
    packetsOk: ok,
    bitErrors,
    bitsCompared,
    ber: bitsCompared ? bitErrors / bitsCompared : NaN,
    per: 1 - ok / o.packets,
    meanSnrDb: snrs.length ? median(snrs) : undefined,
    packets,
  };
}

// ---------------------------------------------------------------- adapter

export const berModem: BerModem = {
  profiles() {
    const d = describe(DEFAULT_CONFIG);
    const modem = PROFILES.map((p) => {
      const info = d.profiles.find((x) => x.name === p.name)!;
      return { id: `modem:${p.name}`, label: `Modem ${p.name} (SF${p.sf}, r=${p.rate})`, rawBps: info.rawBps, netBps: info.netBps };
    });
    const cands = allCandidates().map((c) => ({ id: `cand:${c.id}`, label: `Uncoded ${c.label}`, rawBps: c.bitRate }));
    return [...modem, ...cands];
  },
  durationSec(profileId, o) {
    return profileId.startsWith('modem:') ? modemLayout(profileId, o).total : candLayout(profileId, o).total;
  },
  txSignal(fs, profileId, o) {
    return profileId.startsWith('modem:') ? modemTx(fs, profileId, o) : candTx(fs, profileId, o);
  },
  analyze(rec, fs, profileId, o) {
    return profileId.startsWith('modem:') ? modemAnalyze(rec, fs, profileId, o) : candAnalyze(rec, fs, profileId, o);
  },
};
