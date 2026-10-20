import { bandInfo, DEFAULT_BAND, type Band } from '../band.ts';
import { symbolsTrajectory, symbolTime, dechirpFft, type CssSymbol } from '../css.ts';
import { Baseband } from '../baseband.ts';
import { grayEncode } from '../gray.ts';
import { applyRamps, renderFrequency } from '../../src/dsp/signal.ts';
import { type Candidate, packSymbols, mAryLlr, estimateEsN0 } from './types.ts';

/** LoRa-style CSS, data as cyclic shift, de-chirp + FFT detection. */
export function cssCandidate(sf: number, band: Band = DEFAULT_BAND, smoothSec = 0, rampSec = 0.005): Candidate {
  const b = bandInfo(band);
  const p = { f0: b.f0, bw: b.bw, sf };
  const N = 1 << sf;
  const Ts = symbolTime(p);
  return {
    id: `css-sf${sf}${smoothSec ? `-s${+(smoothSec * 1000).toFixed(2)}` : ''}`,
    label: `CSS SF${sf} (${(Ts * 1000).toFixed(1)} ms)${smoothSec ? ` glide ${+(smoothSec * 1000).toFixed(2)} ms` : ''}`,
    family: 'CSS',
    bitRate: sf / Ts,
    constantEnvelope: true,
    modulate(bits, fs) {
      const syms: CssSymbol[] = packSymbols(bits, sf).map((v) => ({ kind: 'up', value: grayEncode(v) }));
      const freq = new Float64Array(Math.ceil(syms.length * Ts * fs));
      symbolsTrajectory(p, syms, fs, freq, 0);
      const out = renderFrequency(freq, fs, smoothSec);
      applyRamps(out, fs, rampSec);
      return out;
    },
    demodulate(x, fs, t0, nbits) {
      const bb = Baseband.of(x, fs, band);
      const nsym = Math.ceil(nbits / sf);
      const zr = new Float64Array(N), zi = new Float64Array(N);
      const re = new Float64Array(N), im = new Float64Array(N);
      const spectra: Float64Array[] = [];
      for (let m = 0; m < nsym; m++) {
        bb.sample(t0 + m * Ts, 1 / b.bw, N, zr, zi);
        dechirpFft(zr, zi, sf, 'up', re, im);
        const pw = new Float64Array(N);
        for (let k = 0; k < N; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
        spectra.push(pw);
      }
      const { es, n0 } = estimateEsN0(spectra);
      const llr: number[] = [];
      for (const pw of spectra) mAryLlr(pw, sf, es, n0, grayEncode, llr);
      return Float64Array.from(llr.slice(0, nbits));
    },
  };
}
