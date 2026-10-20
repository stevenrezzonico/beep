import { besselI0 } from './kaiser.ts';

/**
 * Band-limited fractional-delay interpolation (Kaiser-windowed sinc) for sampling the complex
 * baseband at arbitrary instants, e.g. the chip instants of a chirp whose rate is not an integer
 * divisor of the device sample rate.
 */
const HALF = 8; // taps on each side
const RES = 512; // table resolution per sample
const BETA = 8; // ~80 dB sidelobes

const table = (() => {
  const t = new Float64Array(2 * HALF * RES + 1);
  const d = besselI0(BETA);
  for (let i = 0; i < t.length; i++) {
    const x = i / RES - HALF;
    const r = x / HALF;
    const w = besselI0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / d;
    t[i] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
  }
  return t;
})();

function kernel(x: number): number {
  // x in [-HALF, HALF]
  const p = (x + HALF) * RES;
  const i = Math.floor(p);
  if (i < 0 || i >= table.length - 1) return 0;
  const f = p - i;
  return table[i] * (1 - f) + table[i + 1] * f;
}

export const INTERP_HALF = HALF;

/**
 * Value of a complex sequence at fractional index t. `base` is the absolute index of re[0].
 * Out-of-range samples are treated as zero.
 */
export function interpComplex(
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  base: number,
  t: number,
  out: { re: number; im: number },
): void {
  const local = t - base;
  const i0 = Math.floor(local);
  const frac = local - i0;
  let sr = 0;
  let si = 0;
  const lo = Math.max(0, i0 - HALF + 1);
  const hi = Math.min(re.length - 1, i0 + HALF);
  for (let i = lo; i <= hi; i++) {
    const k = kernel(i - i0 - frac);
    sr += k * re[i];
    si += k * im[i];
  }
  out.re = sr;
  out.im = si;
}
