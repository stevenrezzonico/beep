import { bandInfo } from './band.ts';
import { symbolTime, symbolsTrajectory, type CssSymbol } from './css.ts';
import { headerSymbols, payloadSymbols, type PhyHeader } from './frame.ts';
import { DEFAULT_CONFIG, type ModemConfig, type Profile } from './profiles.ts';
import { renderFrequency, applyRamps } from '../src/dsp/signal.ts';

/**
 * Transmitter: packet bytes → constant-envelope, continuous-phase CSS waveform.
 *
 *   [nUp × up-chirp(0)] [nDown × down-chirp] [header @ sfPre] [payload @ profile SF]
 *
 * One frequency at a time, phase-continuous throughout, every frequency step softened by a
 * `glide` (D-007), raised-cosine amplitude ramps at both ends. `level` is the peak amplitude
 * (keep headroom below 1.0 for the output chain; see docs/DECISIONS.md D-010).
 */
export interface TxOptions {
  level?: number;
  /** Silence added before/after, seconds (lets the receiver's filters settle). */
  padSec?: number;
}

export interface TxPlan {
  segments: { kind: 'preamble' | 'header' | 'payload'; sf: number; syms: CssSymbol[] }[];
  /** Air time in seconds (without padding). */
  duration: number;
}

export function planPacket(data: Uint8Array, profile: Profile, cfg: ModemConfig = DEFAULT_CONFIG): TxPlan {
  const h: PhyHeader = { profile: profile.id, length: data.length };
  const pre: CssSymbol[] = [];
  for (let i = 0; i < cfg.nUp; i++) pre.push({ kind: 'up', value: 0 });
  for (let i = 0; i < cfg.nDown; i++) pre.push({ kind: 'down', value: 0 });
  const hdr = headerSymbols(h, cfg.sfPre, cfg.nHeader).map((value): CssSymbol => ({ kind: 'up', value }));
  const pay = payloadSymbols(h, data, profile.sf, profile.rate).map((value): CssSymbol => ({ kind: 'up', value }));
  const b = bandInfo(cfg.band);
  const tp = symbolTime({ bw: b.bw, sf: cfg.sfPre });
  const duration = tp * (cfg.nUp + cfg.nDown) + tp * hdr.length + symbolTime({ bw: b.bw, sf: profile.sf }) * pay.length;
  return {
    segments: [
      { kind: 'preamble', sf: cfg.sfPre, syms: pre },
      { kind: 'header', sf: cfg.sfPre, syms: hdr },
      { kind: 'payload', sf: profile.sf, syms: pay },
    ],
    duration,
  };
}

export function airTime(lengthBytes: number, profile: Profile, cfg: ModemConfig = DEFAULT_CONFIG): number {
  return planPacket(new Uint8Array(lengthBytes), profile, cfg).duration;
}

export function modulatePacket(data: Uint8Array, profile: Profile, fs: number, cfg: ModemConfig = DEFAULT_CONFIG, opt: TxOptions = {}): Float32Array {
  const plan = planPacket(data, profile, cfg);
  const b = bandInfo(cfg.band);
  const pad = opt.padSec ?? 0.05;
  const n = Math.ceil((plan.duration + 2 * pad) * fs);
  const freq = new Float64Array(n);
  const i0 = Math.ceil(pad * fs);
  const i1 = Math.ceil((pad + plan.duration) * fs);
  let t = pad;
  for (const s of plan.segments) t = symbolsTrajectory({ f0: b.f0, bw: b.bw, sf: s.sf }, s.syms, fs, freq, t);
  // render only the active span so the glide kernel sees no artificial step to 0 Hz
  const active = renderFrequency(freq.subarray(i0, i1), fs, cfg.glide, opt.level ?? 0.5);
  applyRamps(active, fs, cfg.ramp);
  const y = new Float32Array(n);
  y.set(active, i0);
  return y;
}
