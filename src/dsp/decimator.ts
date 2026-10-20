import { designLowpass } from './kaiser.ts';

/**
 * Streaming complex FIR low-pass + integer decimator. State is carried between calls, so the
 * output is bit-identical no matter how the input is chunked (a requirement for deterministic
 * detection). Output sample m is computed from input samples up to index m*decim.
 */
export class FirDecimator {
  readonly taps: Float64Array;
  readonly decim: number;
  private readonly len: number;
  private readonly hRe: Float64Array; // history, doubled so the dot product is contiguous
  private readonly hIm: Float64Array;
  private pos = 0;
  private phase = 0;

  constructor(taps: Float64Array, decim: number) {
    this.taps = taps;
    this.decim = decim;
    this.len = taps.length;
    this.hRe = new Float64Array(2 * this.len);
    this.hIm = new Float64Array(2 * this.len);
  }

  /** Push one complex sample; returns true and writes into out if an output was produced. */
  push(re: number, im: number, out: { re: number; im: number }): boolean {
    const L = this.len;
    this.pos = this.pos === 0 ? L - 1 : this.pos - 1;
    this.hRe[this.pos] = re;
    this.hRe[this.pos + L] = re;
    this.hIm[this.pos] = im;
    this.hIm[this.pos + L] = im;
    const produce = this.phase === 0;
    this.phase = this.phase + 1 === this.decim ? 0 : this.phase + 1;
    if (!produce) return false;
    // newest sample at pos, oldest at pos+L-1
    const h = this.taps;
    const hr = this.hRe;
    const hi = this.hIm;
    let sr = 0;
    let si = 0;
    const p = this.pos;
    for (let k = 0; k < L; k++) {
      sr += h[k] * hr[p + k];
      si += h[k] * hi[p + k];
    }
    out.re = sr;
    out.im = si;
    return true;
  }

  /** Group delay in input samples of this stage. */
  get delay(): number {
    return (this.len - 1) / 2;
  }
}

export interface DownconverterOptions {
  fs: number;
  /** Centre frequency mixed to 0 Hz. */
  fCenter: number;
  /** One-sided bandwidth that must pass flat (Hz from centre). */
  passHalfHz: number;
  /** One-sided edge beyond which everything must be rejected (Hz from centre). */
  stopHalfHz: number;
  /** Stop-band attenuation in dB. */
  attenDb?: number;
  /** Minimum output rate as a multiple of 2*stopHalfHz (oversampling for later interpolation). */
  minOversample?: number;
}

/**
 * Real passband → complex baseband: mix fCenter to DC, then two decimating low-pass stages.
 * Together they form the receiver's band-pass filter: everything further than stopHalfHz from
 * fCenter is attenuated by attenDb before any detection happens.
 */
export class Downconverter {
  readonly fs: number;
  readonly fCenter: number;
  readonly outRate: number;
  readonly decim: number;
  /** Total group delay, in input samples. */
  readonly delay: number;
  readonly stage1: FirDecimator;
  readonly stage2: FirDecimator;
  private n = 0; // absolute input sample index
  private readonly ratio: number;
  private readonly tmp = { re: 0, im: 0 };
  private readonly tmp2 = { re: 0, im: 0 };

  constructor(o: DownconverterOptions) {
    const atten = o.attenDb ?? 60;
    const over = o.minOversample ?? 3;
    this.fs = o.fs;
    this.fCenter = o.fCenter;
    this.ratio = o.fCenter / o.fs;
    const D = Math.max(1, Math.floor(o.fs / (over * 2 * o.stopHalfHz)));
    // split D = D1*D2 with D1 the largest divisor <= sqrt-ish so stage 1 does the cheap bulk
    let D1 = D;
    for (let d = Math.floor(D / 2); d >= 2; d--) {
      if (D % d === 0) {
        D1 = d;
        break;
      }
    }
    const D2 = D / D1;
    const f1 = o.fs / D1;
    // Stage 1: protect ±stopHalf from aliasing when decimating by D1 (wide, cheap transition).
    const h1 = designLowpass({ fs: o.fs, passHz: o.stopHalfHz, stopHz: Math.max(f1 - o.stopHalfHz, o.stopHalfHz * 1.5), attenDb: atten });
    // Stage 2: the sharp channel filter (pass ±passHalf, reject beyond ±stopHalf).
    const h2 = designLowpass({ fs: f1, passHz: o.passHalfHz, stopHz: o.stopHalfHz, attenDb: atten });
    this.stage1 = new FirDecimator(h1, D1);
    this.stage2 = new FirDecimator(h2, D2);
    this.decim = D;
    this.outRate = o.fs / D;
    this.delay = this.stage1.delay + D1 * this.stage2.delay;
  }

  /** Input-sample time (seconds) represented by output sample m. */
  timeOf(m: number): number {
    return (m * this.decim - this.delay) / this.fs;
  }

  /** Number of input samples consumed so far. */
  get inputCount(): number {
    return this.n;
  }

  /** Process a chunk; appends baseband samples to outRe/outIm (plain arrays for cheap growth). */
  process(x: ArrayLike<number>, outRe: number[], outIm: number[]): void {
    const t = this.tmp;
    const t2 = this.tmp2;
    for (let i = 0; i < x.length; i++) {
      const ph = 2 * Math.PI * ((this.n * this.ratio) % 1);
      this.n++;
      const v = x[i];
      if (this.stage1.push(v * Math.cos(ph), -v * Math.sin(ph), t)) {
        if (this.stage2.push(t.re, t.im, t2)) {
          outRe.push(t2.re);
          outIm.push(t2.im);
        }
      }
    }
  }
}
