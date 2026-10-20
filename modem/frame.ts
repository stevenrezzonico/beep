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
  /** Common bin offset δ the header was found at (carrier drift since the preamble), bins. */
  offset: number;
  /** Mean fractional residual of the header chirps that peaked exactly at codeword+δ, bins. */
  residual: number;
  /** Σ normalised power at the chosen codeword's bins (noise mean n). */
  evidence: number;
  /** Acceptance threshold for `evidence`. */
  threshold: number;
  /** Metric difference best − second-best codeword. */
  margin: number;
  reason?: string;
}

/** Largest common bin offset searched (±10 Hz at SF8 ≈ ±0.2 m/s of velocity change), D-024. */
export const HEADER_MAX_OFFSET = 2;

/**
 * Soft ML header decode from per-symbol power spectra normalised to noise mean 1 per bin.
 * `es` is the estimated peak excess (signal energy) per symbol in the same units. `frac` holds
 * each symbol's fractional peak offset (bins) at its argmax.
 *
 * In chirp modulation a carrier offset of one whole bin is indistinguishable from data value +1,
 * so if the carrier drifted by ≥ ½ bin between the preamble and the header (a hand-held phone
 * swaying by a few cm/s at SF8), every header chirp would read one bin off. The search therefore
 * also covers a common offset δ ∈ [−HEADER_MAX_OFFSET, HEADER_MAX_OFFSET]; the decoded δ then
 * re-anchors the receiver's carrier estimate for the payload.
 */
export function decodeHeader(powers: Float64Array[], frac: number[], sf: number, n: number, es: number, threshold: number): HeaderDecode {
  const shift = sf - 8;
  const N = 1 << sf;
  const a = 2 * Math.sqrt(Math.max(es, 1e-3));
  const metric = powers.slice(0, n).map((p) => {
    const m = new Float64Array(N);
    for (let v = 0; v < N; v++) m[v] = lnI0(a * Math.sqrt(p[v]));
    return m;
  });
  const cws = codewords(n);
  let best = -Infinity, second = -Infinity, bi = 0, bo = 0;
  for (let off = -HEADER_MAX_OFFSET; off <= HEADER_MAX_OFFSET; off++) {
    for (let info = 0; info < cws.length; info++) {
      const cw = cws[info];
      let sum = 0;
      for (let i = 0; i < n; i++) sum += metric[i][((cw[i] << shift) + off + N) % N];
      if (sum > best) {
        second = best;
        best = sum;
        bi = info;
        bo = off;
      } else if (sum > second) second = sum;
    }
  }
  let evidence = 0, agree = 0, rsum = 0;
  for (let i = 0; i < n; i++) {
    const p = powers[i];
    const bin = ((cws[bi][i] << shift) + bo + N) % N;
    evidence += p[bin];
    let m = 0;
    for (let k = 1; k < N; k++) if (p[k] > p[m]) m = k;
    // within ±1 bin: the carrier may drift by up to a bin across the header under hand motion
    const dist = Math.min((m - bin + N) % N, (bin - m + N) % N);
    if (dist <= 1) agree++;
    if (dist === 0) rsum += frac[i];
  }
  const out: HeaderDecode = { header: null, offset: bo, residual: agree ? rsum / agree : 0, evidence, threshold, margin: best - second };
  if (evidence < threshold) return { ...out, reason: 'weak' };
  // Real chirps read at the wrong alignment (a sync one symbol off, another packet) are strong,
  // and with k = 2 some codeword matches any two of them, so evidence alone is not enough: most
  // header chirps must actually peak at (±1 bin of) the decoded codeword. At −14 dB (SER ≈ 12%,
  // the long-range limit) fewer than ⌊n/2⌋+1 agreeing chirps out of n = 8 has probability
  // ≈ 0.3%; for misaligned chirps, chance agreement beyond the 2 the code can force is
  // ≈ C(6,3)·(3/256)³ ≈ 3·10⁻⁵.
  if (agree < Math.floor(n / 2) + 1) return { ...out, reason: 'inconsistent' };
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
