import { bandInfo, DEFAULT_BAND, type Band } from '../band.ts';
import { Baseband } from '../baseband.ts';
import { grayEncode } from '../gray.ts';
import { applyRamps } from '../../src/dsp/signal.ts';
import { type Candidate, packSymbols, mAryLlr, estimateEsN0 } from './types.ts';

export interface MfskOptions {
  /** Tones per group (2^k). */
  m: number;
  /** Number of interleaved tone groups used in rotation (1 = no hopping). */
  groups?: number;
  /** Tone spacing in units of 1/T (1 = orthogonal minimum, >1 = wider/non-orthogonal-tolerant). */
  spacing?: number;
  /** Detection window T, seconds. If omitted, chosen so all tones fill the occupied band. */
  window?: number;
  /** Guard time: each tone lasts window+guard, detection uses the last `window` seconds. */
  guard?: number;
  band?: Band;
  id?: string;
}

/**
 * Continuous-phase M-FSK with optional frequency hopping between interleaved tone groups
 * (consecutive symbols use disjoint tones, so a symbol's reverberant tail lands on bins the next
 * decision ignores) and optional guard extension. BFSK is m = 2.
 */
export function mfskCandidate(o: MfskOptions): Candidate {
  const band = o.band ?? DEFAULT_BAND;
  const b = bandInfo(band);
  const G = o.groups ?? 1;
  const sp = o.spacing ?? 1;
  const total = o.m * G;
  // tones at fc + (i − (total−1)/2)·Δ must fit the occupied band: total·Δ ≤ BW
  const T = o.window ?? (total * sp) / b.bw;
  const df = sp / T;
  if (total * df > b.bw + 1e-6) throw new Error(`MFSK tones (${total}×${df.toFixed(1)} Hz) exceed band`);
  const Tg = o.guard ?? 0;
  const Tsym = T + Tg;
  const k = Math.log2(o.m);
  const freqOf = (group: number, v: number) => b.fc + (group + G * v - (total - 1) / 2) * df;
  return {
    id: o.id ?? `mfsk${o.m}${G > 1 ? `h${G}` : ''}${sp !== 1 ? `s${sp}` : ''}${Tg ? `g${Math.round(Tg * 1000)}` : ''}`,
    label: `${o.m === 2 ? 'BFSK' : `${o.m}-FSK`} T=${(T * 1000).toFixed(1)} ms Δf=${df.toFixed(1)} Hz${G > 1 ? ` hop×${G}` : ''}${Tg ? ` guard ${(Tg * 1000).toFixed(0)} ms` : ''}`,
    family: o.m === 2 ? 'BFSK' : 'MFSK',
    bitRate: k / Tsym,
    constantEnvelope: true,
    modulate(bits, fs) {
      const vals = packSymbols(bits, k).map(grayEncode);
      const n = Math.ceil(vals.length * Tsym * fs) + 1;
      const out = new Float32Array(n);
      let phase = 0;
      for (let s = 0; s < vals.length; s++) {
        const f = freqOf(s % G, vals[s]);
        const t0 = s * Tsym;
        const i0 = Math.ceil(t0 * fs - 1e-9);
        const i1 = Math.min(n, Math.ceil((t0 + Tsym) * fs - 1e-9));
        for (let i = i0; i < i1; i++) out[i] = Math.cos(phase + 2 * Math.PI * f * (i / fs - t0));
        phase = (phase + 2 * Math.PI * f * Tsym) % (2 * Math.PI);
      }
      applyRamps(out, fs, 0.005);
      return out;
    },
    demodulate(x, fs, t0, nbits) {
      const bb = Baseband.of(x, fs, band);
      const nsym = Math.ceil(nbits / k);
      const npts = Math.max(8, Math.round(T * bb.rate));
      const dt = T / npts;
      const zr = new Float64Array(npts), zi = new Float64Array(npts);
      const spectra: Float64Array[] = [];
      for (let s = 0; s < nsym; s++) {
        const ws = t0 + s * Tsym + Tg;
        bb.sample(ws, dt, npts, zr, zi);
        const g = s % G;
        const pw = new Float64Array(o.m);
        for (let v = 0; v < o.m; v++) {
          const w = (2 * Math.PI * (freqOf(g, v) - b.fc) * dt);
          let sr = 0, si = 0;
          for (let i = 0; i < npts; i++) {
            const c = Math.cos(w * i), sn = Math.sin(w * i);
            sr += zr[i] * c + zi[i] * sn;
            si += zi[i] * c - zr[i] * sn;
          }
          pw[v] = sr * sr + si * si;
        }
        spectra.push(pw);
      }
      const { es, n0 } = estimateEsN0(spectra);
      const llr: number[] = [];
      for (const pw of spectra) mAryLlr(pw, k, es, n0, grayEncode, llr);
      return Float64Array.from(llr.slice(0, nbits));
    },
  };
}

/** On-off keying of a single carrier with raised-cosine edges. */
export function ookCandidate(T = 0.01, ramp = 0.002, band: Band = DEFAULT_BAND): Candidate {
  const b = bandInfo(band);
  return {
    id: `ook${Math.round(T * 1000)}`,
    label: `OOK T=${(T * 1000).toFixed(0)} ms`,
    family: 'OOK',
    bitRate: 1 / T,
    constantEnvelope: false,
    modulate(bits, fs) {
      const n = Math.ceil(bits.length * T * fs) + 1;
      const out = new Float32Array(n);
      for (let s = 0; s < bits.length; s++) {
        if (!bits[s]) continue;
        const t0 = s * T;
        const i0 = Math.ceil(t0 * fs - 1e-9);
        const i1 = Math.min(n, Math.ceil((t0 + T) * fs - 1e-9));
        for (let i = i0; i < i1; i++) {
          const tau = i / fs - t0;
          const g = tau < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * tau) / ramp) : tau > T - ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (T - tau)) / ramp) : 1;
          out[i] = g * Math.cos(2 * Math.PI * b.fc * (i / fs));
        }
      }
      return out;
    },
    demodulate(x, fs, t0, nbits) {
      const bb = Baseband.of(x, fs, band);
      const npts = Math.max(4, Math.round((T - 2 * ramp) * bb.rate));
      const dt = (T - 2 * ramp) / npts;
      const e = new Float64Array(nbits);
      for (let s = 0; s < nbits; s++) {
        let acc = 0;
        for (let i = 0; i < npts; i++) {
          const v = bb.at(t0 + s * T + ramp + i * dt);
          acc += v.re * v.re + v.im * v.im;
        }
        e[s] = acc / npts;
      }
      // two-cluster threshold (k-means, 10 iterations) — no genie knowledge of levels
      const sorted = Array.from(e).sort((a, c) => a - c);
      let lo = sorted[Math.floor(sorted.length * 0.25)], hi = sorted[Math.floor(sorted.length * 0.75)];
      for (let it = 0; it < 10; it++) {
        const th = (lo + hi) / 2;
        let sl = 0, nl = 0, sh = 0, nh = 0;
        for (const v of e) if (v < th) { sl += v; nl++; } else { sh += v; nh++; }
        if (nl) lo = sl / nl;
        if (nh) hi = sh / nh;
      }
      const th = (lo + hi) / 2;
      const scale = Math.max(hi - lo, 1e-30);
      return e.map((v) => (4 * (th - v)) / scale);
    },
  };
}
