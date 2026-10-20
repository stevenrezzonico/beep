import { crc16, pushBits, readBits, bytesToBits, bitsToBytes } from './fec/crc.ts';
import { convEncode, viterbiDecode, codedLength, type CodeRate } from './fec/conv.ts';
import { interleave, deinterleave } from './fec/interleave.ts';
import { rsEncode } from './fec/rs.ts';
import { grayEncode } from './gray.ts';
import { lnI0 } from './candidates/types.ts';

/**
 * Bit-level framing (no DSP): PHY header and payload blocks ↔ symbol values.
 *
 * PHY header — 12 information bits, sent at the preamble SF:
 *   profile  2  which payload SF/code follows (3 = reserved)
 *   length   8  payload bytes − 1  (1…256)
 *   rsv      2  must be 0 in v1 (receivers reject non-zero: version escape, see PROTOCOL.md)
 * coded as a Reed–Solomon (n, 2) codeword over GF(256) — the 12 bits are the two information
 * symbols — with one RS symbol per chirp (value v sent as bin v·2^(SF−8)). Any two headers differ
 * in at least n−1 chirps, so the decoder survives whole-symbol errors, which is how a non-coherent
 * M-ary channel actually fails. A bit-level convolutional code cannot: with only a handful of
 * symbols, one wrong chirp corrupts a large burst of its coded bits. Decoding is soft maximum
 * likelihood over all 4096 possible headers (cheap: 4096 × n table lookups), and a header is
 * accepted only if its evidence beats what noise would produce (no separate CRC needed; the
 * payload CRC-16 covers the header fields as well).
 * Only what the receiver needs before it can decode the payload goes here, because these chirps
 * are paid for at the slowest rate. Everything else lives in the payload (docs/PROTOCOL.md).
 *
 * Payload block: data bytes ‖ CRC-16 (over header fields ‖ data) → K=7 conv code (zero-tail) at
 * the profile rate → pseudo-random bit interleaver → SF-bit Gray-mapped symbols.
 */

export const HEADER_INFO_BITS = 12;

export interface PhyHeader {
  profile: number;
  length: number; // payload bytes, 1..256
}

function headerFields(h: PhyHeader): number[] {
  if (h.length < 1 || h.length > 256) throw new Error('payload length must be 1..256 bytes');
  const b: number[] = [];
  pushBits(b, h.profile, 2);
  pushBits(b, h.length - 1, 8);
  pushBits(b, 0, 2);
  return b;
}

export function headerInfo(h: PhyHeader): number {
  return readBits(headerFields(h), 0, 12);
}

const cwCache = new Map<number, Uint8Array[]>();
/** All 4096 header codewords for code length n. */
function codewords(n: number): Uint8Array[] {
  let c = cwCache.get(n);
  if (!c) {
    c = [];
    for (let info = 0; info < 1 << HEADER_INFO_BITS; info++) c.push(rsEncode(Uint8Array.of(info >> 8, info & 0xff), n - 2));
    cwCache.set(n, c);
  }
  return c;
}

export function headerSymbols(h: PhyHeader, sf: number, n: number): number[] {
  if (sf < 8) throw new Error('header needs SF ≥ 8 (one GF(256) symbol per chirp)');
  return Array.from(codewords(n)[headerInfo(h)], (v) => v << (sf - 8));
}

export interface HeaderDecode {
  header: PhyHeader | null;
  /** Σ normalised power at the chosen codeword's bins (noise mean n). */
  evidence: number;
  /** Acceptance threshold for `evidence`. */
  threshold: number;
  /** Metric difference best − second-best codeword. */
  margin: number;
  reason?: string;
}

/**
 * Soft ML header decode from per-symbol power spectra normalised to noise mean 1 per bin.
 * `es` is the estimated peak excess (signal energy) per symbol in the same units.
 */
export function decodeHeader(powers: Float64Array[], sf: number, n: number, es: number, threshold: number): HeaderDecode {
  const shift = sf - 8;
  const a = 2 * Math.sqrt(Math.max(es, 1e-3));
  const metric = powers.slice(0, n).map((p) => {
    const m = new Float64Array(256);
    for (let v = 0; v < 256; v++) m[v] = lnI0(a * Math.sqrt(p[v << shift]));
    return m;
  });
  const cws = codewords(n);
  let best = -Infinity, second = -Infinity, bi = 0;
  for (let info = 0; info < cws.length; info++) {
    const cw = cws[info];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += metric[i][cw[i]];
    if (sum > best) {
      second = best;
      best = sum;
      bi = info;
    } else if (sum > second) second = sum;
  }
  let evidence = 0;
  for (let i = 0; i < n; i++) evidence += powers[i][cws[bi][i] << shift];
  const out: HeaderDecode = { header: null, evidence, threshold, margin: best - second };
  if (evidence < threshold) return { ...out, reason: 'weak' };
  if ((bi & 3) !== 0) return { ...out, reason: 'reserved bits set (newer version?)' };
  return { ...out, header: { profile: bi >> 10, length: ((bi >> 2) & 0xff) + 1 } };
}

/** Coded bits → symbol values (Gray-mapped bin indices) of `sf` bits each, MSB first. */
export function bitsToSymbols(coded: Uint8Array, sf: number): number[] {
  const syms: number[] = [];
  for (let i = 0; i < coded.length; i += sf) {
    let v = 0;
    for (let j = 0; j < sf; j++) v = (v << 1) | (coded[i + j] ?? 0);
    syms.push(grayEncode(v));
  }
  return syms;
}

export function payloadCodedLength(lengthBytes: number, rate: CodeRate): number {
  return codedLength(8 * lengthBytes + 16, rate, 'zero');
}

export function payloadSymbolCount(lengthBytes: number, sf: number, rate: CodeRate): number {
  return Math.ceil(payloadCodedLength(lengthBytes, rate) / sf);
}

export function payloadSymbols(h: PhyHeader, data: Uint8Array, sf: number, rate: CodeRate): number[] {
  if (data.length !== h.length) throw new Error('header length mismatch');
  const bits = Array.from(bytesToBits(data));
  const crc = crc16([...headerFields(h), ...bits]);
  pushBits(bits, crc, 16);
  return bitsToSymbols(interleave(convEncode(bits, rate, 'zero')), sf);
}

export interface PayloadDecode {
  data: Uint8Array | null;
  /** Coded bits whose hard decision disagreed with the re-encoded decoded word. */
  correctedBits: number;
  codedBits: number;
}

export function decodePayload(h: PhyHeader, llr: Float64Array, rate: CodeRate): PayloadDecode {
  const n = payloadCodedLength(h.length, rate);
  const deint = deinterleave(llr.slice(0, n));
  const nb = 8 * h.length + 16;
  const v = viterbiDecode(deint, nb, rate, 'zero');
  const re = convEncode(v.bits, rate, 'zero');
  let corrected = 0;
  for (let i = 0; i < n; i++) corrected += (deint[i] < 0 ? 1 : 0) ^ re[i];
  const dataBits = v.bits.subarray(0, 8 * h.length);
  const ok = crc16([...headerFields(h), ...dataBits]) === readBits(v.bits, 8 * h.length, 16);
  return { data: ok ? bitsToBytes(dataBits) : null, correctedBits: corrected, codedBits: n };
}
