import { bandInfo, DEFAULT_BAND, type Band } from './band.ts';
import type { CodeRate } from './fec/conv.ts';

/**
 * Modem configuration. Every number here is justified in docs/DECISIONS.md and backed by a
 * simulator result in sim/results/ (the decision id is noted next to each).
 */
export interface Profile {
  /** 2-bit id carried in the PHY header. */
  id: number;
  name: string;
  /** Spreading factor of payload symbols. */
  sf: number;
  /** Convolutional code rate of the payload. */
  rate: CodeRate;
}

export interface ModemConfig {
  band: Band;
  /** Spreading factor of the preamble and of the PHY header (= the most robust profile's). */
  sfPre: number;
  /** Number of identical up-chirps at the start of the preamble. */
  nUp: number;
  /** Number of down-chirps after the up-chirps (they separate carrier offset from timing). */
  nDown: number;
  /** PHY header length in chirps: Reed–Solomon (nHeader, 2) over GF(256). */
  nHeader: number;
  /**
   * Decision-directed tracking loop gains (D-012). Carrier: proportional/integral gain on the
   * per-symbol residual bin offset. Timing: proportional/integral gain (chips per unit of the
   * early/late error) of the early/late gate. 0 disables a path.
   */
  trackP: number;
  trackI: number;
  trackT: number;
  trackTI: number;
  /** Loops update only when a symbol's peak exceeds trackGate·ln N × the noise mean. */
  trackGate: number;
  /** Up-chirp windows integrated for detection (≤ nUp − 1 so a full window always fits). */
  detWindows: number;
  /** Per-window false-alarm probability used to derive the detection threshold. */
  pfa: number;
  /** Frequency glide at every frequency step, seconds (D-007). */
  glide: number;
  /** Raised-cosine amplitude ramp at packet start/end, seconds. */
  ramp: number;
  profiles: Profile[];
}

export const PROFILES: Profile[] = [
  { id: 0, name: 'long-range', sf: 8, rate: '1/2' },
  { id: 1, name: 'balanced', sf: 7, rate: '1/2' },
  { id: 2, name: 'fast', sf: 5, rate: '2/3' },
];

export const DEFAULT_CONFIG: ModemConfig = {
  band: DEFAULT_BAND,
  sfPre: 8,
  nUp: 8,
  nDown: 4,
  nHeader: 8,
  trackP: 0.3,
  trackI: 0.03,
  trackT: 0.3,
  trackTI: 0.02,
  trackGate: 8,
  detWindows: 7,
  pfa: 1e-6,
  glide: 0.002,
  ramp: 0.005,
  profiles: PROFILES,
};

export function profileById(cfg: ModemConfig, id: number): Profile | undefined {
  return cfg.profiles.find((p) => p.id === id);
}

export function profileByName(cfg: ModemConfig, name: string): Profile {
  const p = cfg.profiles.find((x) => x.name === name);
  if (!p) throw new Error(`unknown profile ${name}`);
  return p;
}

/** Derived timing numbers for display and docs. */
export function describe(cfg: ModemConfig = DEFAULT_CONFIG) {
  const b = bandInfo(cfg.band);
  const ts = (sf: number) => (1 << sf) / b.bw;
  return {
    bw: b.bw,
    preambleSec: ts(cfg.sfPre) * (cfg.nUp + cfg.nDown),
    profiles: cfg.profiles.map((p) => ({
      ...p,
      symbolSec: ts(p.sf),
      rawBps: p.sf / ts(p.sf),
      netBps: (p.sf / ts(p.sf)) * (p.rate === '1/2' ? 0.5 : p.rate === '2/3' ? 2 / 3 : 0.75),
    })),
  };
}
