import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from './pool.ts';
import { allCandidates, candidateById } from '../modem/candidates/index.ts';
import { allConditions } from './conditions.ts';
import type { BerPoint } from './jobs.ts';
import { paprDb, leakageDbc } from './metrics.ts';
import { svgPlot } from './plot.ts';
import { runModem, runPreamble, runFalseAlarm, runFec, runTracking } from './modem-sim.ts';
import { Rng } from '../src/dsp/prng.ts';

/**
 * Simulator entry point.
 *   npm run sim            full sweep (minutes; results committed under sim/results/)
 *   npm run sim:quick      reduced sweep for CI
 *   npm run sim -- --only candidates|modem
 */
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : 'all';
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(import.meta.dirname, quick ? 'out' : 'results');
mkdirSync(outDir, { recursive: true });

/** SNR (dB) where a descending-SNR curve first crosses `target`, log-interpolated. */
export function crossing(points: BerPoint[], target: number): number | null {
  const pts = [...points].sort((a, b) => a.snr - b.snr);
  for (let i = pts.length - 1; i > 0; i--) {
    const hi = pts[i], lo = pts[i - 1];
    if (hi.ber <= target && lo.ber > target) {
      const lh = Math.log10(Math.max(hi.ber, 1e-7)), ll = Math.log10(lo.ber), lt = Math.log10(target);
      return lo.snr + ((ll - lt) / (ll - lh)) * (hi.snr - lo.snr);
    }
  }
  if (pts.length && pts.every((p) => p.ber <= target)) return -Infinity;
  return null;
}

const fmt = (v: number | null) => (v === null ? 'floor' : v === -Infinity ? '< min' : v.toFixed(1));

async function runCandidates(pool: Pool) {
  const cands = allCandidates();
  const conds = allConditions();
  const snrs: number[] = [];
  for (let s = 30; s >= -30; s -= quick ? 4 : 2) snrs.push(s);
  const jobs: Promise<{ cand: string; cond: string; pts: BerPoint[] }>[] = [];
  for (const c of cands)
    for (const k of conds)
      jobs.push(
        pool
          .run<BerPoint[]>('candidateBer', { cand: c.id, cond: k.id, snrs, budgetSec: quick ? 6 : 40, minErrors: quick ? 40 : 150, fsTx: 48000, fsRx: 44100 })
          .then((pts) => {
            process.stdout.write('.');
            return { cand: c.id, cond: k.id, pts };
          }),
      );
  const res = await Promise.all(jobs);
  process.stdout.write('\n');
  // static waveform metrics
  const rng = new Rng(1);
  const static_ = cands.map((c) => {
    const x = c.modulate(rng.bits(Math.max(256, Math.round(c.bitRate * 2))), 48000);
    return { id: c.id, papr: paprDb(x), leak: leakageDbc(x, 48000), leak16: leakageDbc(x, 48000, 16000), leakNl: leakageDbc(x, 48000, 16900, 0.05) };
  });
  writeFileSync(join(outDir, 'candidates.json'), JSON.stringify({ conditions: conds.map((k) => ({ id: k.id, label: k.label })), static: static_, results: res }, null, 1));
  // markdown table: SNR for BER 1e-2 and 1e-3 per condition
  const lines: string[] = [];
  lines.push(`| Candidate | Raw bit/s | Const. env. | PAPR dB | Leak dBc <16.9k / <16k / <16.9k after k3 | ${conds.map((k) => `${k.id} @1e-2 / 1e-3`).join(' | ')} |`);
  lines.push(`|${'---|'.repeat(5 + conds.length)}`);
  for (const c of cands) {
    const s = static_.find((x) => x.id === c.id)!;
    const cells = conds.map((k) => {
      const r = res.find((x) => x.cand === c.id && x.cond === k.id)!;
      return `${fmt(crossing(r.pts, 1e-2))} / ${fmt(crossing(r.pts, 1e-3))}`;
    });
    lines.push(`| ${c.label} | ${c.bitRate.toFixed(1)} | ${c.constantEnvelope ? 'yes' : 'no'} | ${s.papr.toFixed(1)} | ${s.leak.toFixed(0)} / ${s.leak16.toFixed(0)} / ${s.leakNl.toFixed(0)} | ${cells.join(' | ')} |`);
  }
  writeFileSync(join(outDir, 'candidates.md'), `Uncoded BER: SNR (dB, peak-referenced, 1.5 kHz band) needed for BER 1e-2 / 1e-3. "floor" = never reached in the sweep.\n\n${lines.join('\n')}\n`);
  for (const k of conds) {
    const series = cands.map((c) => ({ name: c.id, points: res.find((x) => x.cand === c.id && x.cond === k.id)!.pts.map((p) => [p.snr, Math.max(p.ber, 1e-5)] as [number, number]) }));
    writeFileSync(join(outDir, `ber-${k.id.replace(/[^a-z0-9-]/gi, '_')}.svg`), svgPlot(`Uncoded BER — ${k.label}`, 'SNR (dB, peak-ref, 1.5 kHz)', 'BER', series, 1e-4));
  }
  console.log(lines.join('\n'));
}

/**
 * CSS frequency-glide study: leakage below the band vs SNR cost, to pick the glide length
 * (see docs/DECISIONS.md D-007).
 */
async function runSmoothing(pool: Pool) {
  const glides = [0, 0.25, 0.5, 1, 1.5, 2, 3];
  const sfs = [5, 7, 9];
  const rows: string[] = ['| SF | glide ms | leak <16.9k dBc | leak <16.0k dBc | leak <16.9k after k3=0.05 | SNR@1e-3 AWGN (dB) |', '|---|---|---|---|---|---|'];
  const snrs: number[] = [];
  for (let s = 4; s >= -30; s -= 1) snrs.push(s);
  const rng = new Rng(3);
  const res: unknown[] = [];
  for (const sf of sfs) {
    const jobs = glides.map((g) => {
      const id = `css-sf${sf}${g ? `-s${g}` : ''}`;
      return pool.run<BerPoint[]>('candidateBer', { cand: id, cond: 'awgn', snrs, budgetSec: quick ? 10 : 120, minErrors: quick ? 30 : 100, fsTx: 48000, fsRx: 44100 }).then((pts) => ({ id, g, pts }));
    });
    for (const j of await Promise.all(jobs)) {
      const c = candidateById(j.id);
      const x = c.modulate(rng.bits(sf * 64), 48000);
      const l1 = leakageDbc(x, 48000, 16900), l2 = leakageDbc(x, 48000, 16000), l3 = leakageDbc(x, 48000, 16900, 0.05);
      res.push({ sf, glideMs: j.g, leak169: l1, leak160: l2, leakNl: l3, pts: j.pts });
      rows.push(`| ${sf} | ${j.g} | ${l1.toFixed(1)} | ${l2.toFixed(1)} | ${l3.toFixed(1)} | ${fmt(crossing(j.pts, 1e-3))} |`);
    }
  }
  writeFileSync(join(outDir, 'smoothing.json'), JSON.stringify(res, null, 1));
  writeFileSync(join(outDir, 'smoothing.md'), rows.join('\n') + '\n');
  console.log(rows.join('\n'));
}

const pool = new Pool();
try {
  if (only === 'smoothing') await runSmoothing(pool);
  if (only === 'all' || only === 'candidates') await runCandidates(pool);
  if (only === 'all' || only === 'modem') await runModem(pool, { quick, outDir });
  if (only === 'all' || only === 'preamble') await runPreamble(pool, { quick, outDir });
  if (only === 'all' || only === 'falsealarm') await runFalseAlarm(pool, { quick, outDir });
  if (only === 'all' || only === 'fec') await runFec(pool, { quick, outDir });
  if (only === 'all' || only === 'tracking') await runTracking(pool, { quick, outDir });
} finally {
  await pool.close();
}
