import { cssCandidate } from './css.ts';
import { mfskCandidate, ookCandidate } from './fsk.ts';
import { dbpskCandidate, dsssCandidate, gmskCandidate, dofdmCandidate } from './psk.ts';
import type { Candidate } from './types.ts';

export type { Candidate } from './types.ts';
export { hardBits } from './types.ts';

/** All modulation candidates evaluated in docs/MODULATION_EVALUATION.md. */
export function allCandidates(): Candidate[] {
  return [
    ookCandidate(0.01),
    mfskCandidate({ m: 2, window: 0.01, id: 'bfsk100' }),
    mfskCandidate({ m: 32, id: 'mfsk32' }),
    mfskCandidate({ m: 16, spacing: 2, id: 'mfsk16w' }),
    mfskCandidate({ m: 16, groups: 2, id: 'mfsk16h2' }),
    mfskCandidate({ m: 32, guard: 0.01, id: 'mfsk32g10' }),
    mfskCandidate({ m: 128, id: 'mfsk128' }),
    gmskCandidate(1000, 0.5),
    dbpskCandidate(800, 0.5),
    dsssCandidate(800, 0.5),
    dofdmCandidate(32, 0.01),
    cssCandidate(5),
    cssCandidate(6),
    cssCandidate(7),
    cssCandidate(8),
    cssCandidate(9),
  ];
}

export function candidateById(id: string): Candidate {
  const m = /^css-sf(\d+)(?:-s([\d.]+))?$/.exec(id);
  if (m) return cssCandidate(Number(m[1]), undefined, m[2] ? Number(m[2]) / 1000 : 0);
  const c = allCandidates().find((x) => x.id === id);
  if (!c) throw new Error(`unknown candidate ${id}`);
  return c;
}
