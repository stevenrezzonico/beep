import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from './pool.ts';
import type { PerPoint } from './jobs.ts';
import { allConditions } from './conditions.ts';
import { DEFAULT_CONFIG, describe as describeCfg, type ModemConfig } from '../modem/profiles.ts';
import { airTime } from '../modem/tx.ts';
import { svgPlot } from './plot.ts';

/** SNR where PER first drops to ≤ target going up in SNR (linear interpolation). */
export function perCrossing(pts: PerPoint[], target: number): number | null {
  const s = [...pts].sort((a, b) => a.snr - b.snr);
  for (let i = 1; i < s.length; i++) {
    if (s[i].per <= target && s[i - 1].per > target) {
      return s[i - 1].snr + ((s[i - 1].per - target) / (s[i - 1].per - s[i].per)) * (s[i].snr - s[i - 1].snr);
    }
  }
  if (s.length && s[0].per <= target) return -Infinity;
  return null;
}

const f = (v: number | null) => (v === null ? 'n/a' : v === -Infinity ? '< min' : v.toFixed(1));

export async function runModem(pool: Pool, o: { quick: boolean; outDir: string }) {
  const snrs: number[] = [];
  for (let s = 6; s >= -28; s -= o.quick ? 3 : 1) snrs.push(s);
  const conds = allConditions();
  const profiles = DEFAULT_CONFIG.profiles;
  const payloadBytes = 32;
  const jobs = [];
  for (const p of profiles)
    for (const k of conds)
      jobs.push(
        pool
          .run<PerPoint[]>('modemPer', { profile: p.name, cond: k.id, snrs, packets: o.quick ? 10 : 50, payloadBytes, fsTx: 48000, fsRx: 44100 })
          .then((pts) => {
            process.stdout.write('.');
            return { profile: p.name, cond: k.id, pts };
          }),
      );
  const res = await Promise.all(jobs);
  process.stdout.write('\n');
  const d = describeCfg();
  const lines = [
    `Packet error rate of the full modem (own sync, header, tracking, Viterbi, CRC) for ${payloadBytes}-byte payloads, 48 kHz TX → 44.1 kHz RX. SNR is peak-referenced in the 1.5 kHz band (sim/channel.ts). Cells: SNR for PER ≤ 10% / ≤ 1%.`,
    '',
    `| Profile | SF | code | net bit/s | air time ${payloadBytes} B (s) | ${conds.map((k) => k.id).join(' | ')} | silent corruptions |`,
    `|${'---|'.repeat(6 + conds.length)}`,
  ];
  for (const p of profiles) {
    const info = d.profiles.find((x) => x.name === p.name)!;
    const cells = conds.map((k) => {
      const r = res.find((x) => x.profile === p.name && x.cond === k.id)!;
      return `${f(perCrossing(r.pts, 0.1))} / ${f(perCrossing(r.pts, 0.01))}`;
    });
    const corrupt = res.filter((x) => x.profile === p.name).reduce((a, r) => a + r.pts.reduce((b, q) => b + q.corrupt, 0), 0);
    lines.push(`| ${p.name} | ${p.sf} | ${p.rate} | ${info.netBps.toFixed(1)} | ${airTime(payloadBytes, p).toFixed(2)} | ${cells.join(' | ')} | ${corrupt} |`);
  }
  writeFileSync(join(o.outDir, 'modem.json'), JSON.stringify({ config: DEFAULT_CONFIG, payloadBytes, results: res }, null, 1));
  writeFileSync(join(o.outDir, 'modem.md'), lines.join('\n') + '\n');
  for (const k of conds) {
    const series = profiles.map((p) => ({ name: p.name, points: res.find((x) => x.profile === p.name && x.cond === k.id)!.pts.map((q) => [q.snr, Math.max(q.per, 1e-3)] as [number, number]) }));
    writeFileSync(join(o.outDir, `per-${k.id.replace(/[^a-z0-9-]/gi, '_')}.svg`), svgPlot(`Modem PER (${payloadBytes} B) — ${k.label}`, 'SNR (dB, peak-ref, 1.5 kHz)', 'PER', series, 1e-2));
  }
  console.log(lines.join('\n'));
  // estimator accuracy table
  const est = ['', '| Profile | cond | true SNR | mean estimated SNR | mean |v| error (m/s) |', '|---|---|---|---|---|'];
  for (const r of res) for (const q of r.pts) if (q.meanSnrEst !== null && q.snr % 6 === 0) est.push(`| ${r.profile} | ${r.cond} | ${q.snr} | ${q.meanSnrEst.toFixed(1)} | ${q.meanAbsVelErr!.toFixed(3)} |`);
  writeFileSync(join(o.outDir, 'modem-estimators.md'), est.join('\n') + '\n');
}

/** Preamble design study: sync/header success vs SNR for alternative preambles of the long-range profile. */
export async function runPreamble(pool: Pool, o: { quick: boolean; outDir: string }) {
  const v = (sfPre: number, nUp: number, nDown: number, nHeader: number) => ({
    label: `SF${sfPre} ${nUp}↑ ${nDown}↓ hdr ${nHeader}`,
    cfg: { sfPre, nUp, nDown, nHeader, detWindows: nUp - 1 },
  });
  const variants: { label: string; cfg: Partial<ModemConfig> }[] = [
    v(8, 6, 2, 5),
    v(8, 6, 4, 5),
    v(8, 6, 4, 6),
    v(8, 8, 4, 6),
    v(8, 8, 4, 8),
    v(8, 10, 4, 6),
    v(8, 10, 6, 8),
    v(9, 5, 3, 5),
  ];


  const snrs: number[] = [];
  for (let s = -8; s >= -24; s -= 1) snrs.push(s);
  const conds = ['awgn', 'room-far'];
  const jobs = [];
  for (const v of variants)
    for (const c of conds)
      jobs.push(pool.run<PerPoint[]>('modemPer', { profile: 'long-range', cond: c, snrs, packets: o.quick ? 25 : 80, payloadBytes: 8, cfg: v.cfg, fsTx: 48000, fsRx: 44100, stopAfterZero: 2 }).then((pts) => ({ v, c, pts })));
  const res = await Promise.all(jobs);
  const rows = ['| Preamble | preamble+header s | ' + conds.map((c) => `${c}: SNR sync ≥90% / header ≥90% / PER≤10% (8 B)`).join(' | ') + ' |', '|---|---|' + conds.map(() => '---|').join('')];
  const at = (pts: PerPoint[], key: 'synced' | 'headerOk' | 'ok') => {
    const s = [...pts].sort((a, b) => a.snr - b.snr);
    const hit = s.find((q) => q[key] / q.sent >= 0.9);
    return hit ? hit.snr.toFixed(0) : 'n/a';
  };
  for (const v of variants) {
    const cfg = { ...DEFAULT_CONFIG, ...v.cfg };
    const pre = ((1 << cfg.sfPre) / 1300) * (cfg.nUp + cfg.nDown + cfg.nHeader);
    rows.push(`| ${v.label} | ${pre.toFixed(2)} | ${conds.map((c) => { const r = res.find((x) => x.v === v && x.c === c)!; return `${at(r.pts, 'synced')} / ${at(r.pts, 'headerOk')} / ${at(r.pts, 'ok')}`; }).join(' | ')} |`);
  }
  writeFileSync(join(o.outDir, 'preamble.md'), rows.join('\n') + '\n');
  writeFileSync(join(o.outDir, 'preamble.json'), JSON.stringify(res.map((r) => ({ label: r.v.label, cfg: r.v.cfg, cond: r.c, pts: r.pts })), null, 1));
  console.log(rows.join('\n'));
}

export async function runFalseAlarm(pool: Pool, o: { quick: boolean; outDir: string }) {
  const minutes = o.quick ? 2 : 30;
  const kinds = ['white', 'tone', 'clicks'] as const;
  const res = await Promise.all(
    kinds.flatMap((kind) => [44100, 48000].map((fs) => pool.run<Record<string, number>>('falseAlarms', { seconds: minutes * 60, fs, kind, seed: fs + kind.length }).then((c) => ({ kind, fs, c })))),
  );
  const rows = [`Noise-only soak, ${minutes} min per row (no transmitter). Any 'packet' here would be a false packet.`, '', '| noise | fs | detect | sync | header | packet |', '|---|---|---|---|---|---|'];
  for (const r of res) rows.push(`| ${r.kind} | ${r.fs} | ${r.c.detect} | ${r.c.sync} | ${r.c.header} | ${r.c.packet} |`);
  writeFileSync(join(o.outDir, 'false-alarm.md'), rows.join('\n') + '\n');
  console.log(rows.join('\n'));
}
