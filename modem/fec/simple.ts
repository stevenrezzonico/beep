/** Simple block codes for the FEC comparison: Hamming(7,4) (soft ML) and repetition. */

const H74: number[][] = [];
for (let d = 0; d < 16; d++) {
  const b = [(d >> 3) & 1, (d >> 2) & 1, (d >> 1) & 1, d & 1];
  H74.push([...b, b[0] ^ b[1] ^ b[3], b[0] ^ b[2] ^ b[3], b[1] ^ b[2] ^ b[3]]);
}

export function hamming74Encode(bits: ArrayLike<number>): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 4) {
    const d = ((bits[i] ?? 0) << 3) | ((bits[i + 1] ?? 0) << 2) | ((bits[i + 2] ?? 0) << 1) | (bits[i + 3] ?? 0);
    out.push(...H74[d]);
  }
  return Uint8Array.from(out);
}

/** Soft maximum-likelihood decode (max correlation over the 16 codewords). */
export function hamming74Decode(llr: ArrayLike<number>, n: number): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < llr.length; i += 7) {
    let best = 0, bm = -Infinity;
    for (let d = 0; d < 16; d++) {
      let m = 0;
      for (let j = 0; j < 7; j++) m += H74[d][j] ? -llr[i + j] : llr[i + j];
      if (m > bm) { bm = m; best = d; }
    }
    out.push(...H74[best].slice(0, 4));
  }
  return Uint8Array.from(out.slice(0, n));
}

export function repetitionEncode(bits: ArrayLike<number>, r: number): Uint8Array {
  const out = new Uint8Array(bits.length * r);
  for (let i = 0; i < bits.length; i++) for (let j = 0; j < r; j++) out[i * r + j] = bits[i];
  return out;
}

export function repetitionDecode(llr: ArrayLike<number>, n: number, r: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < r; j++) s += llr[i * r + j];
    out[i] = s < 0 ? 1 : 0;
  }
  return out;
}
