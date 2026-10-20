/** Deterministic PRNG (xoshiro128**) so every simulation and test is reproducible from a seed. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spare: number | null = null;

  constructor(seed = 1) {
    // splitmix32 to expand the seed
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** Uniform 32-bit unsigned integer. */
  u32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    this.s0 >>>= 0; this.s1 >>>= 0; this.s2 >>>= 0; this.s3 >>>= 0;
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Standard normal (Box–Muller). */
  gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  bits(n: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = this.u32() & 1;
    return b;
  }

  bytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = this.u32() & 0xff;
    return b;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
