import { Downconverter } from '../src/dsp/decimator.ts';
import { interpComplex, INTERP_HALF } from '../src/dsp/interp.ts';
import { bandInfo, type Band, DEFAULT_BAND } from './band.ts';

/**
 * Complex baseband view of a real recording, centred on the band centre and band-limited to the
 * allowed band (this is the receiver's band-pass). Samples can be read at any instant (seconds,
 * on the recording's clock), so callers never deal with sample-rate-specific indices.
 */
export class Baseband {
  readonly re: number[] = [];
  readonly im: number[] = [];
  readonly dc: Downconverter;
  /** Absolute index of re[0] (samples before it were discarded). */
  base = 0;
  readonly fs: number;
  private readonly tmp = { re: 0, im: 0 };

  constructor(fs: number, band: Band = DEFAULT_BAND) {
    this.fs = fs;
    const b = bandInfo(band);
    this.dc = new Downconverter({
      fs,
      fCenter: b.fc,
      passHalfHz: b.bw / 2,
      stopHalfHz: (b.fHigh - b.fLow) / 2,
    });
  }

  static of(x: ArrayLike<number>, fs: number, band: Band = DEFAULT_BAND): Baseband {
    const b = new Baseband(fs, band);
    b.push(x);
    b.flush();
    return b;
  }

  get rate(): number {
    return this.dc.outRate;
  }

  push(x: ArrayLike<number>): void {
    this.dc.process(x, this.re, this.im);
  }

  /** Push zeros to flush the filter delay (offline use). */
  flush(): void {
    this.dc.process(new Float32Array(Math.ceil(this.dc.delay) + 4 * this.dc.decim), this.re, this.im);
  }

  /** Fractional baseband index of time t (s). */
  indexOf(t: number): number {
    return (t * this.fs + this.dc.delay) / this.dc.decim;
  }

  /** Latest time that can be read with full interpolation support. */
  get endTime(): number {
    const lastIdx = this.base + this.re.length - 1 - INTERP_HALF;
    return (lastIdx * this.dc.decim - this.dc.delay) / this.fs;
  }

  /** Complex sample at time t (s). Returns a shared object — copy fields immediately. */
  at(t: number): { re: number; im: number } {
    interpComplex(this.re, this.im, this.base, this.indexOf(t), this.tmp);
    return this.tmp;
  }

  /** Sample n points at t0 + k·dt into re/im arrays. */
  sample(t0: number, dt: number, n: number, re: Float64Array, im: Float64Array): void {
    for (let k = 0; k < n; k++) {
      const v = this.at(t0 + k * dt);
      re[k] = v.re;
      im[k] = v.im;
    }
  }

  /** Drop samples older than time t (keeps interpolation support). */
  discardBefore(t: number): void {
    const keepFrom = Math.floor(this.indexOf(t)) - INTERP_HALF - 2;
    const drop = keepFrom - this.base;
    if (drop > 4096) {
      this.re.splice(0, drop);
      this.im.splice(0, drop);
      this.base += drop;
    }
  }
}
