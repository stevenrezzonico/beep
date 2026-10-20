/**
 * CRCs over bit arrays (MSB-first), so fields that are not byte-aligned can be protected without
 * padding. Polynomials chosen for best Hamming distance at our lengths (Koopman's tables):
 *  - CRC-16/CCITT 0x1021: HD 4 up to 32 767 bits — the per-packet integrity check.
 *  - CRC-8 0x07 (ATM HEC): HD 4 up to 119 bits — the short PHY header.
 */
function crcBits(bits: ArrayLike<number>, width: number, poly: number, init: number): number {
  const top = 1 << (width - 1);
  const mask = (1 << width) - 1;
  let c = init & mask;
  for (let i = 0; i < bits.length; i++) {
    const fb = ((c & top) !== 0 ? 1 : 0) ^ (bits[i] & 1);
    c = (c << 1) & mask;
    if (fb) c ^= poly;
  }
  return c;
}

export function crc16(bits: ArrayLike<number>): number {
  return crcBits(bits, 16, 0x1021, 0xffff);
}

export function crc8(bits: ArrayLike<number>): number {
  return crcBits(bits, 8, 0x07, 0x00);
}

export function crc32Bytes(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function crc16Bytes(data: Uint8Array): number {
  return crc16(bytesToBits(data));
}

export function bytesToBits(data: Uint8Array): Uint8Array {
  const b = new Uint8Array(data.length * 8);
  for (let i = 0; i < data.length; i++) for (let k = 0; k < 8; k++) b[i * 8 + k] = (data[i] >> (7 - k)) & 1;
  return b;
}

export function bitsToBytes(bits: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/** Append `width` bits of v (MSB first). */
export function pushBits(out: number[], v: number, width: number): void {
  for (let i = width - 1; i >= 0; i--) out.push((v >>> i) & 1);
}

/** Read `width` bits (MSB first) at position pos. */
export function readBits(bits: ArrayLike<number>, pos: number, width: number): number {
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 2 + (bits[pos + i] & 1);
  return v;
}
