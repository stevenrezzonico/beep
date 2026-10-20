import { bandInfo, DEFAULT_BAND, type Band } from '../band.ts';
import { Baseband } from '../baseband.ts';
import { type Candidate } from './types.ts';

/** Root-raised-cosine pulse value at t (seconds) for symbol period T and roll-off β. */
function rrc(t: number, T: number, beta: number): number {
  const x = t / T;
  if (Math.abs(x) < 1e-9) return 1 - beta + (4 * beta) / Math.PI;
  if (Math.abs(Math.abs(4 * beta * x) - 1) < 1e-9) {
    return (beta / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
  }
  return (Math.sin(Math.PI * x * (1 - beta)) + 4 * beta * x * Math.cos(Math.PI * x * (1 + beta))) / (Math.PI * x * (1 - (4 * beta * x) ** 2));
}

const SPAN = 6; // pulse truncated to ±SPAN symbols

function normalisePeak(y: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < y.length; i++) m = Math.max(m, Math.abs(y[i]));
  if (m > 0) for (let i = 0; i < y.length; i++) y[i] /= m;
  return y;
}

/** Real passband of a ±1 symbol stream shaped with RRC at rate 1/T on carrier fc. */
function rrcPassband(sym: number[], T: number, beta: number, fc: number, fs: number): Float32Array {
  const lead = SPAN * T;
  const n = Math.ceil((sym.length * T + 2 * lead) * fs);
  const y = new Float32Array(n);
  for (let k = 0; k < sym.length; k++) {
    const tc = lead + k * T;
    const i0 = Math.max(0, Math.floor((tc - SPAN * T) * fs));
    const i1 = Math.min(n, Math.ceil((tc + SPAN * T) * fs));
    for (let i = i0; i < i1; i++) y[i] += sym[k] * rrc(i / fs - tc, T, beta);
  }
  for (let i = 0; i < n; i++) y[i] *= Math.cos((2 * Math.PI * fc * i) / fs);
  return normalisePeak(y);
}

/** Matched-filter outputs at symbol centres t0 + SPAN·T + k·T. */
function rrcMatched(bb: Baseband, t0: number, T: number, beta: number, count: number): { re: Float64Array; im: Float64Array } {
  const os = 4;
  const dt = T / os;
  const taps: number[] = [];
  for (let m = -SPAN * os; m <= SPAN * os; m++) taps.push(rrc(m * dt, T, beta));
  const re = new Float64Array(count), im = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const tc = t0 + SPAN * T + k * T;
    let sr = 0, si = 0;
    for (let m = -SPAN * os; m <= SPAN * os; m++) {
      const v = bb.at(tc + m * dt);
      const h = taps[m + SPAN * os];
      sr += v.re * h;
      si += v.im * h;
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

/** Differential BPSK, RRC-shaped (not constant envelope), non-coherent differential detection. */
export function dbpskCandidate(baud = 800, beta = 0.5, band: Band = DEFAULT_BAND): Candidate {
  const b = bandInfo(band);
  const T = 1 / baud;
  if ((1 + beta) * baud > b.bw) throw new Error('DBPSK exceeds band');
  return {
    id: `dbpsk${baud}`,
    label: `DBPSK ${baud} Bd RRC β=${beta}`,
    family: 'DPSK',
    bitRate: baud,
    constantEnvelope: false,
    modulate(bits, fs) {
      const sym = [1];
      for (const bit of bits) sym.push(sym[sym.length - 1] * (bit ? -1 : 1));
      return rrcPassband(sym, T, beta, b.fc, fs);
    },
    demodulate(x, fs, t0, nbits) {
      const bb = Baseband.of(x, fs, band);
      const { re, im } = rrcMatched(bb, t0, T, beta, nbits + 1);
      const d = new Float64Array(nbits);
      let scale = 0;
      for (let k = 0; k < nbits; k++) {
        d[k] = re[k + 1] * re[k] + im[k + 1] * im[k];
        scale += Math.abs(d[k]);
      }
      scale = scale / nbits || 1;
      return d.map((v) => (4 * v) / scale);
    },
  };
}

/** m-sequence of length 2^deg − 1 from a Fibonacci LFSR, as ±1 chips. */
function mSequence(deg: number, taps: number[]): number[] {
  let state = 1;
  const out: number[] = [];
  for (let i = 0; i < (1 << deg) - 1; i++) {
    const bit = state & 1;
    out.push(bit ? -1 : 1);
    let fb = 0;
    for (const t of taps) fb ^= (state >> (deg - t)) & 1;
    state = (state >> 1) | (fb << (deg - 1));
  }
  return out;
}

/** DSSS: each bit spreads over a length-31 m-sequence of RRC chips; differential bit detection. */
export function dsssCandidate(chipRate = 800, beta = 0.5, band: Band = DEFAULT_BAND): Candidate {
  const b = bandInfo(band);
  const T = 1 / chipRate;
  const code = mSequence(5, [5, 3]);
  const L = code.length;
  return {
    id: `dsss${L}`,
    label: `DSSS L=${L} @ ${chipRate} chip/s (DBPSK)`,
    family: 'DSSS',
    bitRate: chipRate / L,
    constantEnvelope: false,
    modulate(bits, fs) {
      const d = [1];
      for (const bit of bits) d.push(d[d.length - 1] * (bit ? -1 : 1));
      const chips: number[] = [];
      for (const v of d) for (const c of code) chips.push(v * c);
      return rrcPassband(chips, T, beta, b.fc, fs);
    },
    demodulate(x, fs, t0, nbits) {
      const bb = Baseband.of(x, fs, band);
      const { re, im } = rrcMatched(bb, t0, T, beta, (nbits + 1) * L);
      const yr = new Float64Array(nbits + 1), yi = new Float64Array(nbits + 1);
      for (let n = 0; n <= nbits; n++) {
        for (let l = 0; l < L; l++) {
          yr[n] += re[n * L + l] * code[l];
          yi[n] += im[n * L + l] * code[l];
        }
      }
      const out = new Float64Array(nbits);
      let scale = 0;
      for (let n = 0; n < nbits; n++) {
        out[n] = yr[n + 1] * yr[n] + yi[n + 1] * yi[n];
        scale += Math.abs(out[n]);
      }
      scale = scale / nbits || 1;
      return out.map((v) => (4 * v) / scale);
    },
  };
}

/** GMSK (h = 0.5, Gaussian BT), constant envelope, 1-bit differential detection. */
export function gmskCandidate(rate = 1000, bt = 0.5, band: Band = DEFAULT_BAND): Candidate {
  const b = bandInfo(band);
  const T = 1 / rate;
  return {
    id: `gmsk${rate}`,
    label: `GMSK ${rate} b/s BT=${bt}`,
    family: 'CPFSK/GMSK',
    bitRate: rate,
    constantEnvelope: true,
    modulate(bits, fs) {
      const lead = 3 * T;
      const n = Math.ceil((bits.length * T + 2 * lead) * fs);
      // NRZ frequency pulses convolved with a Gaussian (σ = √ln2 / (2π·BT/T))
      const sigma = Math.sqrt(Math.log(2)) / (2 * Math.PI * (bt / T));
      const freq = new Float64Array(n);
      const q = (t: number) => 0.5 * (erf((t + T / 2) / (Math.SQRT2 * sigma)) - erf((t - T / 2) / (Math.SQRT2 * sigma)));
      for (let k = 0; k < bits.length; k++) {
        const a = bits[k] ? -1 : 1;
        const tc = lead + (k + 0.5) * T;
        const i0 = Math.max(0, Math.floor((tc - 3 * T) * fs));
        const i1 = Math.min(n, Math.ceil((tc + 3 * T) * fs));
        for (let i = i0; i < i1; i++) freq[i] += a * q(i / fs - tc);
      }
      const y = new Float32Array(n);
      let ph = 0;
      const dev = 0.5 / (2 * T); // h/(2T)
      for (let i = 0; i < n; i++) {
        y[i] = Math.cos(ph);
        ph += (2 * Math.PI * (b.fc + dev * freq[i])) / fs;
      }
      const ramp = Math.round(0.005 * fs);
      for (let i = 0; i < ramp; i++) {
        const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
        y[i] *= g;
        y[n - 1 - i] *= g;
      }
      return y;
    },
    demodulate(x, fs, t0, nbits) {
      const bb = Baseband.of(x, fs, band);
      const lead = 3 * T;
      const out = new Float64Array(nbits);
      let scale = 0;
      for (let k = 0; k < nbits; k++) {
        const a = bb.at(t0 + lead + k * T);
        const ar = a.re, ai = a.im;
        const c = bb.at(t0 + lead + (k + 1) * T);
        // Im(c · conj(a)) > 0 ⇒ phase advanced ⇒ positive deviation ⇒ bit 0
        out[k] = c.im * ar - c.re * ai;
        scale += Math.abs(out[k]);
      }
      scale = scale / nbits || 1;
      return out.map((v) => (4 * v) / scale);
    },
  };
}

function erf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/**
 * Differential OFDM: K sub-carriers across the occupied band, DBPSK in time on each, cyclic
 * prefix against reverb, short raised-cosine overlap between symbols. Many simultaneous tones, so
 * high peak-to-average power — the peak normalisation charges that to its SNR.
 */
export function dofdmCandidate(k = 32, cp = 0.01, band: Band = DEFAULT_BAND): Candidate {
  const b = bandInfo(band);
  const df = b.bw / k;
  const T = 1 / df;
  const r = 0.001;
  const Tsym = T + cp + r;
  const fk = (i: number) => b.f0 + (i + 0.5) * df;
  return {
    id: `dofdm${k}`,
    label: `D-OFDM ${k} carriers, T=${(T * 1000).toFixed(1)}+${(cp * 1000).toFixed(0)} ms CP`,
    family: 'OFDM',
    bitRate: k / Tsym,
    constantEnvelope: false,
    modulate(bits, fs) {
      const nsym = Math.ceil(bits.length / k) + 1; // +1 reference symbol
      const n = Math.ceil((nsym * Tsym + cp + 2 * r) * fs);
      const y = new Float32Array(n);
      const ph = new Float64Array(k);
      for (let i = 0; i < k; i++) ph[i] = (Math.PI * i * i) / k; // Newman phases (low PAPR reference)
      for (let s = 0; s < nsym; s++) {
        if (s > 0) for (let i = 0; i < k; i++) if (bits[(s - 1) * k + i]) ph[i] += Math.PI;
        const tu = r + cp + s * Tsym; // start of useful part
        const a = tu - cp - r;
        const e = tu + T + r;
        const i0 = Math.max(0, Math.ceil(a * fs));
        const i1 = Math.min(n, Math.ceil(e * fs));
        for (let i = i0; i < i1; i++) {
          const t = i / fs;
          const w = t < a + r ? 0.5 - 0.5 * Math.cos((Math.PI * (t - a)) / r) : t > tu + T ? 0.5 + 0.5 * Math.cos((Math.PI * (t - tu - T)) / r) : 1;
          let v = 0;
          for (let c = 0; c < k; c++) v += Math.cos(2 * Math.PI * fk(c) * (t - tu) + ph[c]);
          y[i] += w * v;
        }
      }
      return normalisePeak(y);
    },
    demodulate(x, fs, t0, nbits) {
      const bb = Baseband.of(x, fs, band);
      const nsym = Math.ceil(nbits / k) + 1;
      const npts = Math.max(2 * k, Math.round(T * bb.rate));
      const dt = T / npts;
      const zr = new Float64Array(npts), zi = new Float64Array(npts);
      const Zr: Float64Array[] = [], Zi: Float64Array[] = [];
      for (let s = 0; s < nsym; s++) {
        const tu = t0 + r + cp + s * Tsym;
        bb.sample(tu, dt, npts, zr, zi);
        const R = new Float64Array(k), I = new Float64Array(k);
        for (let c = 0; c < k; c++) {
          const w = 2 * Math.PI * (fk(c) - b.fc) * dt;
          let sr = 0, si = 0;
          for (let i = 0; i < npts; i++) {
            const cs = Math.cos(w * i), sn = Math.sin(w * i);
            sr += zr[i] * cs + zi[i] * sn;
            si += zi[i] * cs - zr[i] * sn;
          }
          R[c] = sr;
          I[c] = si;
        }
        Zr.push(R);
        Zi.push(I);
      }
      const out = new Float64Array(nbits);
      let scale = 0;
      for (let j = 0; j < nbits; j++) {
        const s = Math.floor(j / k) + 1;
        const c = j % k;
        out[j] = Zr[s][c] * Zr[s - 1][c] + Zi[s][c] * Zi[s - 1][c];
        scale += Math.abs(out[j]);
      }
      scale = scale / nbits || 1;
      return out.map((v) => (4 * v) / scale);
    },
  };
}
