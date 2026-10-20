/**
 * In-place iterative radix-2 complex FFT on split real/imag Float64Arrays.
 * Twiddle and bit-reversal tables are cached per size. Sizes must be powers of two.
 */

interface FftPlan {
  n: number;
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const plans = new Map<number, FftPlan>();

export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function getPlan(n: number): FftPlan {
  let p = plans.get(n);
  if (p) return p;
  if (!isPow2(n)) throw new Error(`FFT size must be a power of two, got ${n}`);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  p = { n, rev, cos, sin };
  plans.set(n, p);
  return p;
}

/** Forward FFT (e^{-j2πkn/N}), in place. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) throw new Error('re/im length mismatch');
  if (n <= 1) return;
  const { rev, cos, sin } = getPlan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Inverse FFT (scaled by 1/N), in place. */
export function ifft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  const s = 1 / re.length;
  for (let i = 0; i < re.length; i++) {
    re[i] *= s;
    im[i] = -im[i] * s;
  }
}

/** |X|^2 of each bin. */
export function powerSpectrum(re: Float64Array, im: Float64Array, out?: Float64Array): Float64Array {
  const o = out ?? new Float64Array(re.length);
  for (let i = 0; i < re.length; i++) o[i] = re[i] * re[i] + im[i] * im[i];
  return o;
}
