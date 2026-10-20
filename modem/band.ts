/**
 * The operating band. Everything in the modem is derived from these numbers (Hz), never from a
 * sample count. Defaults follow the brief: 17.0–18.5 kHz, with a guard at each edge so filter
 * transitions fall outside the occupied band. Shift up (e.g. 17.5–19.0) for devices with good
 * response above 18.5 kHz, but never below 17.0 kHz by default.
 */
export interface Band {
  /** Lower edge of the allowed band, Hz. Nothing we transmit lies below this. */
  fLow: number;
  /** Upper edge of the allowed band, Hz. */
  fHigh: number;
  /**
   * Guard inside each edge, Hz. The occupied signal spans [fLow+guard, fHigh-guard]; the guard is
   * the receive filter's transition band (pass at fLow+guard, ≥60 dB rejection at fLow).
   */
  guard: number;
}

export const DEFAULT_BAND: Band = { fLow: 17000, fHigh: 18500, guard: 100 };

export interface BandInfo extends Band {
  /** Occupied lower/upper edge. */
  f0: number;
  f1: number;
  /** Occupied bandwidth, Hz. */
  bw: number;
  /** Centre, Hz. */
  fc: number;
}

export function bandInfo(b: Band = DEFAULT_BAND): BandInfo {
  if (b.fLow < 17000) console.warn(`band fLow ${b.fLow} Hz is below 17 kHz: likely audible`);
  const f0 = b.fLow + b.guard;
  const f1 = b.fHigh - b.guard;
  if (!(f1 > f0)) throw new Error('band too narrow for its guard');
  return { ...b, f0, f1, bw: f1 - f0, fc: (f0 + f1) / 2 };
}
