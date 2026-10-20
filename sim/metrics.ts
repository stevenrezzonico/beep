import { welch } from '../src/dsp/spectrum.ts';
import { applyChannel } from './channel.ts';

/** Peak-to-average power ratio, dB (over the non-silent part). */
export function paprDb(x: Float32Array): number {
  let pk = 0, p = 0, n = 0;
  for (const v of x) {
    pk = Math.max(pk, v * v);
    if (v !== 0) { p += v * v; n++; }
  }
  return 10 * Math.log10(pk / (p / Math.max(1, n)));
}

/**
 * Audible leakage: power below `fAudible` (default 16.9 kHz, i.e. outside the band with a small
 * margin for the analysis window) relative to the total, dBc. Measured on the clean waveform
 * (onsets, discontinuities) and after the speaker model (k3 cubic), which exposes
 * intermodulation of simultaneous tones.
 */
export function leakageDbc(x: Float32Array, fs: number, fAudible = 16900, k3 = 0): number {
  let y = x;
  if (k3) y = applyChannel(x, { fsTx: fs, fsRx: fs, snrDb: Infinity, speakerK3: k3 }).y;
  const s = welch(y, fs, 8192);
  let below = 0, total = 0;
  for (let k = 1; k < s.freqs.length; k++) {
    const p = Math.pow(10, s.db[k] / 10);
    total += p;
    if (s.freqs[k] >= 20 && s.freqs[k] < fAudible) below += p;
  }
  return 10 * Math.log10(Math.max(below, 1e-30) / total);
}
