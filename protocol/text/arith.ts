/**
 * Binary-output arithmetic coder (Witten–Neal–Cleary, 32-bit). All arithmetic stays below 2^53,
 * so results are exact and identical in every JavaScript engine — encoder and decoder must agree
 * bit for bit across devices.
 */
const HALF = 2 ** 31;
const Q1 = 2 ** 30;
const Q3 = 3 * 2 ** 30;

export class ArithEncoder {
  private low = 0;
  private high = 2 ** 32 - 1;
  private pending = 0;
  readonly bits: number[] = [];

  private emit(b: number): void {
    this.bits.push(b);
    for (; this.pending > 0; this.pending--) this.bits.push(1 - b);
  }

  encode(cumLow: number, cumHigh: number, total: number): void {
    const range = this.high - this.low + 1;
    this.high = this.low + Math.floor((range * cumHigh) / total) - 1;
    this.low = this.low + Math.floor((range * cumLow) / total);
    for (;;) {
      if (this.high < HALF) this.emit(0);
      else if (this.low >= HALF) {
        this.emit(1);
        this.low -= HALF;
        this.high -= HALF;
      } else if (this.low >= Q1 && this.high < Q3) {
        this.pending++;
        this.low -= Q1;
        this.high -= Q1;
      } else break;
      this.low = 2 * this.low;
      this.high = 2 * this.high + 1;
    }
  }

  /** Equiprobable raw bit. */
  encodeBit(b: number): void {
    this.encode(b, b + 1, 2);
  }

  finish(): number[] {
    this.pending++;
    this.emit(this.low < Q1 ? 0 : 1);
    return this.bits;
  }
}

export class ArithDecoder {
  private low = 0;
  private high = 2 ** 32 - 1;
  private value = 0;
  private pos = 0;
  private readonly bits: ArrayLike<number>;

  constructor(bits: ArrayLike<number>) {
    this.bits = bits;
    for (let i = 0; i < 32; i++) this.value = 2 * this.value + this.next();
  }

  private next(): number {
    return this.pos < this.bits.length ? this.bits[this.pos++] : (this.pos++, 0);
  }

  /** Cumulative count the next symbol falls in (call `consume` with its range afterwards). */
  target(total: number): number {
    const range = this.high - this.low + 1;
    return Math.floor(((this.value - this.low + 1) * total - 1) / range);
  }

  consume(cumLow: number, cumHigh: number, total: number): void {
    const range = this.high - this.low + 1;
    this.high = this.low + Math.floor((range * cumHigh) / total) - 1;
    this.low = this.low + Math.floor((range * cumLow) / total);
    for (;;) {
      if (this.high < HALF) {
        /* nothing */
      } else if (this.low >= HALF) {
        this.low -= HALF;
        this.high -= HALF;
        this.value -= HALF;
      } else if (this.low >= Q1 && this.high < Q3) {
        this.low -= Q1;
        this.high -= Q1;
        this.value -= Q1;
      } else break;
      this.low = 2 * this.low;
      this.high = 2 * this.high + 1;
      this.value = 2 * this.value + this.next();
    }
  }

  decodeBit(): number {
    const t = this.target(2);
    const b = t >= 1 ? 1 : 0;
    this.consume(b, b + 1, 2);
    return b;
  }

  /** Bits consumed beyond the input (diagnostic: large values mean a truncated stream). */
  get overrun(): number {
    return Math.max(0, this.pos - this.bits.length);
  }
}
