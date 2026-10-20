import {
  LayoutBuilder, locateMarker, rampedTone, render, segRange, noiseAmp, ampDb, linfit,
  subtractNoiseDb, round, type Segment, TONE_RAMP,
} from './common.ts';

/**
 * Attenuation vs distance. At each distance the TX sends three tones spread over the band (one
 * tone could sit in a room-mode null), the RX measures each tone's level and the noise at that
 * frequency, and appends a row. Fitting all rows separates spherical spreading (20·log10 d) from
 * air/absorption loss (α dB/m), which is what limits range at 17–18.5 kHz.
 */
export interface DistanceOptions {
  freqs: number[];
  toneSec: number;
  silenceSec: number;
}

export const DISTANCE_DEFAULTS: DistanceOptions = { freqs: [17250, 17750, 18250], toneSec: 1.5, silenceSec: 1.2 };

export function distanceLayout(o: DistanceOptions = DISTANCE_DEFAULTS): { segs: Segment[]; total: number } {
  const b = new LayoutBuilder();
  for (const f of o.freqs) b.add({ name: 'tone', freq: f, dur: o.toneSec }, 0.1);
  b.gap(0.3);
  b.add({ name: 'silence', dur: o.silenceSec });
  return { segs: b.segs, total: b.total(0.1) };
}

export function distanceSignal(fs: number, o: DistanceOptions = DISTANCE_DEFAULTS): Float32Array {
  const { segs, total } = distanceLayout(o);
  return render(fs, total, segs, (s) => (s.name === 'tone' ? rampedTone(s.freq!, s.dur, fs) : null));
}

export interface DistanceRow {
  distanceM: number;
  /** Per-tone signal level (noise-subtracted), dBFS. */
  tones: { freq: number; levelDb: number; noiseDb: number; snrDb: number }[];
  /** Power average over tones, noise-subtracted, dBFS. */
  levelDb: number;
  noiseDb: number;
  snrDb: number;
  markerScore: number;
  note?: string;
}

/** Measurement block: 0.1 s gives ~15 Hz Hann resolution; levels are the power mean of blocks. */
const BLOCK = 0.1;

export function analyzeDistance(rec: Float32Array, fs: number, distanceM: number, o: DistanceOptions = DISTANCE_DEFAULTS): DistanceRow {
  const m = locateMarker(rec, fs);
  const { segs } = distanceLayout(o);
  const sil = segs.find((s) => s.name === 'silence')!;
  const [sa, sb] = segRange(fs, m.time, sil, 0.2, rec.length);
  const tones: DistanceRow['tones'] = [];
  for (const s of segs.filter((x) => x.name === 'tone')) {
    const [a, b] = segRange(fs, m.time, s, TONE_RAMP + 0.05, rec.length);
    // average power over blocks rather than one long DFT: fading from small movements averages out
    const tot = ampDb(noiseAmp(rec, fs, s.freq!, a, b, BLOCK));
    const noiseDb = ampDb(noiseAmp(rec, fs, s.freq!, sa, sb, BLOCK));
    const levelDb = subtractNoiseDb(tot, noiseDb);
    tones.push({ freq: s.freq!, levelDb: round(levelDb), noiseDb: round(noiseDb), snrDb: round(levelDb - noiseDb) });
  }
  const pmean = (v: number[]) => 10 * Math.log10(v.reduce((acc, x) => acc + Math.pow(10, x / 10), 0) / v.length);
  const levelDb = pmean(tones.map((t) => t.levelDb));
  const noiseDb = pmean(tones.map((t) => t.noiseDb));
  return {
    distanceM,
    tones,
    levelDb: round(levelDb),
    noiseDb: round(noiseDb),
    snrDb: round(levelDb - noiseDb),
    markerScore: round(m.score, 3),
  };
}

export interface DistanceFit {
  /** L(d) = L0 − 20·log10(d) − α·d */
  spreadingPlusAbsorption: { L0: number; alphaDbPerM: number; rmsDb: number } | null;
  /** L(d) = A − 10·n·log10(d) */
  freeExponent: { A: number; n: number; rmsDb: number } | null;
  /** Distance at which the fitted SNR would fall to `snrTargetDb`, if a noise level is known. */
  rangeAtSnr?: { snrTargetDb: number; distanceM: number } | null;
  rowsUsed: number;
}

/**
 * Least-squares fits. Rows with SNR < 6 dB are excluded: their noise-subtracted level is too
 * uncertain to constrain α.
 */
export function fitDistance(rows: DistanceRow[], snrTargetDb = 0): DistanceFit {
  const ok = rows.filter((r) => r.snrDb >= 6 && r.distanceM > 0 && Number.isFinite(r.levelDb));
  const distinct = new Set(ok.map((r) => r.distanceM)).size;
  if (distinct < 2) return { spreadingPlusAbsorption: null, freeExponent: null, rangeAtSnr: null, rowsUsed: ok.length };
  const d = ok.map((r) => r.distanceM);
  const y = ok.map((r) => r.levelDb + 20 * Math.log10(r.distanceM));
  const f1 = linfit(d, y);
  const f2 = linfit(d.map((v) => Math.log10(v)), ok.map((r) => r.levelDb));
  const noise = 10 * Math.log10(ok.reduce((a, r) => a + Math.pow(10, r.noiseDb / 10), 0) / ok.length);
  // solve L0 − 20log10(x) − αx = noise + target by bisection on x ∈ (0.01, 1000)
  let range: number | null = null;
  const g = (x: number) => f1.a - 20 * Math.log10(x) + f1.b * x - noise - snrTargetDb;
  if (g(0.01) > 0 && g(1000) < 0) {
    let lo = 0.01, hi = 1000;
    for (let i = 0; i < 80; i++) {
      const mid = Math.sqrt(lo * hi);
      if (g(mid) > 0) lo = mid; else hi = mid;
    }
    range = lo;
  }
  return {
    spreadingPlusAbsorption: { L0: round(f1.a), alphaDbPerM: round(-f1.b, 3), rmsDb: round(f1.rms) },
    freeExponent: { A: round(f2.a), n: round(-f2.b / 10, 3), rmsDb: round(f2.rms) },
    rangeAtSnr: range === null ? null : { snrTargetDb, distanceM: round(range, 1) },
    rowsUsed: ok.length,
  };
}

export function distanceCsv(rows: DistanceRow[]): string {
  const freqs = rows[0]?.tones.map((t) => t.freq) ?? [];
  const head = ['distance_m', 'level_dbfs', 'noise_dbfs', 'snr_db', ...freqs.map((f) => `level_${f}`), ...freqs.map((f) => `snr_${f}`)];
  const lines = rows.map((r) => [r.distanceM, r.levelDb, r.noiseDb, r.snrDb, ...r.tones.map((t) => t.levelDb), ...r.tones.map((t) => t.snrDb)].join(','));
  return [head.join(','), ...lines].join('\n');
}
