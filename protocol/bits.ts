/** Bit-level writer/reader (MSB first) with Exp-Golomb integers, for bit-packed headers. */
export class BitWriter {
  private bits: number[] = [];

  write(v: number, width: number): this {
    for (let i = width - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) & 1);
    return this;
  }

  bit(b: boolean | number): this {
    this.bits.push(b ? 1 : 0);
    return this;
  }

  /**
   * Order-0 Exp-Golomb: v ≥ 0 costs 2⌊log2(v+1)⌋+1 bits (0→1 bit, 1–2→3, 3–6→5, 7–14→7 …), so
   * small counts — the common case — are nearly free and there is no upper limit.
   */
  expGolomb(v: number): this {
    const x = v + 1;
    const n = Math.floor(Math.log2(x));
    for (let i = 0; i < n; i++) this.bits.push(0);
    return this.write(x, n + 1);
  }

  bytes(b: Uint8Array): this {
    for (const v of b) this.write(v, 8);
    return this;
  }

  get length(): number {
    return this.bits.length;
  }

  toBits(): number[] {
    return this.bits.slice();
  }

  /** Byte-align with "1 then 0s" padding so the reader can find the true end (ISO 7816-4 style). */
  toBytesPadded(): Uint8Array {
    const b = [...this.bits, 1];
    while (b.length % 8) b.push(0);
    return packBits(b);
  }

  /** Zero-pad to a byte boundary (for content whose own syntax marks its end). */
  toBytes(): Uint8Array {
    const b = [...this.bits];
    while (b.length % 8) b.push(0);
    return packBits(b);
  }
}

export function packBits(b: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 8));
  for (let i = 0; i < b.length; i++) if (b[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

export function unpackBits(data: Uint8Array): number[] {
  const out: number[] = [];
  for (const v of data) for (let k = 7; k >= 0; k--) out.push((v >> k) & 1);
  return out;
}

export class BitReader {
  pos = 0;
  readonly bits: number[];
  readonly end: number;

  constructor(bits: number[], end = bits.length) {
    this.bits = bits;
    this.end = end;
  }

  /** Reader over "1 then 0s"-padded bytes; returns null if the padding is malformed. */
  static fromPadded(data: Uint8Array): BitReader | null {
    const b = unpackBits(data);
    let e = b.length - 1;
    while (e >= 0 && b[e] === 0) e--;
    if (e < 0) return null;
    return new BitReader(b, e);
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  read(width: number): number {
    if (this.pos + width > this.end) throw new RangeError('read past end');
    let v = 0;
    for (let i = 0; i < width; i++) v = v * 2 + this.bits[this.pos++];
    return v;
  }

  bit(): number {
    return this.read(1);
  }

  expGolomb(): number {
    let n = 0;
    while (this.read(1) === 0) {
      n++;
      if (n > 40) throw new RangeError('bad exp-golomb');
    }
    let x = 1;
    for (let i = 0; i < n; i++) x = x * 2 + this.read(1);
    return x - 1;
  }

  /** Remaining whole bytes (requires byte alignment of the remainder). */
  restBytes(): Uint8Array {
    const n = Math.floor(this.remaining / 8);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.read(8);
    return out;
  }
}
