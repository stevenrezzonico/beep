import { fft, ifft, nextPow2 } from '../../src/dsp/fft.ts';
import { applyRamps } from '../../src/dsp/signal.ts';
import { DEFAULT_MARKER } from '../../src/dsp/marker.ts';
import { LayoutBuilder, locateMarker, render, linfit, mean, round, type Segment } from './common.ts';

/**
 * Echo / reverb: short in-band chirps separated by long silences. Matched filtering a chirp
 * compresses it to a ~1/BW pulse, so the filter output is the room's band-limited impulse
 * response (direct path + reflections + diffuse tail) in exactly the band the modem uses. From
 * it we derive the decay figures that set symbol length and guard interval, and export the IR
 * so the simulator can replay this room.
 */
export interface EchoOptions {
  bursts: number;
  chirpSec: number;
  f0: number;
  f1: number;
  /** Silence after each burst; must exceed the decay time we hope to measure. */
  spacingSec: number;
  /** IR length exported/analysed after the direct peak. */
  irSec: number;
}

export const ECHO_DEFAULTS: EchoOptions = {
  bursts: 4,
  chirpSec: 0.02,
  f0: DEFAULT_MARKER.f0,
  f1: DEFAULT_MARKER.f1,
  spacingSec: 1.2,
  irSec: 0.8,
};

/** 1 ms ramps: long enough to avoid clicks, short enough not to narrow a 20 ms chirp's band much. */
const CHIRP_RAMP = 0.001;

function chirp(fs: number, o: EchoOptions, analytic = false): { re: Float32Array; im: Float32Array } {
  const n = Math.round(o.chirpSec * fs);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const k = (o.f1 - o.f0) / o.chirpSec;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const ph = 2 * Math.PI * (o.f0 * t + 0.5 * k * t * t);
    re[i] = Math.cos(ph);
    if (analytic) im[i] = Math.sin(ph);
  }
  applyRamps(re, fs, CHIRP_RAMP);
  if (analytic) applyRamps(im, fs, CHIRP_RAMP);
  return { re, im };
}

export function echoLayout(o: EchoOptions = ECHO_DEFAULTS): { segs: Segment[]; total: number } {
  const b = new LayoutBuilder();
  // marker's own echo must die out before the first burst
  b.gap(0.5);
  for (let i = 0; i < o.bursts; i++) b.add({ name: 'burst', f0: o.f0, f1: o.f1, dur: o.chirpSec }, o.spacingSec);
  return { segs: b.segs, total: b.total(0) };
}

export function echoSignal(fs: number, o: EchoOptions = ECHO_DEFAULTS): Float32Array {
  const { segs, total } = echoLayout(o);
  const c = chirp(fs, o).re;
  return render(fs, total, segs, (s) => (s.name === 'burst' ? c : null));
}

export interface EchoResult {
  test: 'echo';
  fs: number;
  markerTime: number;
  burstsUsed: number;
  /** Peak of the matched-filter envelope over the pre-direct noise, dB. */
  peakToNoiseDb: number;
  /** Seconds after the direct peak. Null when noise hides the level. */
  edtSec: number | null;
  rt60FromT20: number | null;
  rt60FromT30: number | null;
  /** Last time the smoothed envelope is within 20/30 dB of the direct peak. */
  tMinus20: number | null;
  tMinus30: number | null;
  /** Direct (±2.5 ms) vs everything after, dB. */
  drrDb: number;
  /** Schroeder decay curve (dB, 5 ms steps) averaged over bursts, for plotting. */
  edc: { t: number; db: number }[];
  /** Smoothed envelope (dB re direct, 2 ms steps), for plotting. */
  envelope: { t: number; db: number }[];
}

export interface MeasuredIr {
  fs: number;
  /** Real passband IR, band-limited to f0..f1, scaled so the direct path has unit gain at (f0+f1)/2. */
  ir: number[];
  meta: { kind: 'bench-echo'; f0: number; f1: number; date: string; note?: string; drrDb: number; rt60: number | null; device?: string };
}

/** Complex correlation of real x[a..b) with the analytic chirp; |c| is the envelope, Re(c) the IR. */
function matched(x: Float32Array, a: number, b: number, tpl: { re: Float32Array; im: Float32Array }) {
  const n = b - a;
  const N = nextPow2(n + tpl.re.length);
  const xr = new Float64Array(N), xi = new Float64Array(N);
  const tr = new Float64Array(N), ti = new Float64Array(N);
  for (let i = 0; i < n; i++) xr[i] = x[a + i];
  for (let i = 0; i < tpl.re.length; i++) { tr[i] = tpl.re[i]; ti[i] = tpl.im[i]; }
  fft(xr, xi);
  fft(tr, ti);
  for (let k = 0; k < N; k++) {
    const r = xr[k] * tr[k] + xi[k] * ti[k];
    const im = xi[k] * tr[k] - xr[k] * ti[k];
    xr[k] = r;
    xi[k] = im;
  }
  ifft(xr, xi);
  return { re: xr.subarray(0, n), im: xi.subarray(0, n) };
}

export function analyzeEcho(rec: Float32Array, fs: number, o: EchoOptions = ECHO_DEFAULTS): { result: EchoResult; ir: MeasuredIr } {
  const m = locateMarker(rec, fs);
  const { segs } = echoLayout(o);
  const tpl = chirp(fs, o, true);
  let e = 0;
  for (let i = 0; i < tpl.re.length; i++) e += tpl.re[i] ** 2 + tpl.im[i] ** 2;
  const pre = 0.15; // noise window before each burst; previous burst's tail has had ≥1 s to decay
  const irN = Math.round(o.irSec * fs);
  const envs: Float64Array[] = [];
  let bestIr: Float64Array | null = null;
  let bestPeak = 0;
  let noiseP = 0;
  for (const s of segs.filter((x) => x.name === 'burst')) {
    const a = Math.round((m.time + s.start - pre) * fs);
    const b = a + Math.round((pre + 0.05) * fs) + irN;
    if (a < 0 || b > rec.length) continue;
    const c = matched(rec, a, b, tpl);
    // direct peak: strongest envelope within ±30 ms of the expected position
    const exp = Math.round(pre * fs);
    const w = Math.round(0.03 * fs);
    let pk = exp;
    let pv = 0;
    for (let i = exp - w; i <= exp + w; i++) {
      const v = c.re[i] ** 2 + c.im[i] ** 2;
      if (v > pv) { pv = v; pk = i; }
    }
    let np = 0;
    const nEnd = pk - Math.round(0.01 * fs);
    for (let i = 0; i < nEnd; i++) np += c.re[i] ** 2 + c.im[i] ** 2;
    noiseP += np / Math.max(1, nEnd) / pv;
    const env = new Float64Array(irN);
    const ir = new Float64Array(irN);
    // start the IR 2 ms before the peak so the band-limited pulse's leading half is kept
    const lead = Math.round(0.002 * fs);
    for (let i = 0; i < irN; i++) {
      const j = pk - lead + i;
      env[i] = j < c.re.length ? (c.re[j] ** 2 + c.im[j] ** 2) / pv : 0;
      ir[i] = j < c.re.length ? c.re[j] / Math.sqrt(pv) : 0;
    }
    envs.push(env);
    if (pv > bestPeak) { bestPeak = pv; bestIr = ir; }
  }
  if (!envs.length || !bestIr) throw new Error('no complete bursts in the recording — record longer');
  const lead = Math.round(0.002 * fs);
  const noise = noiseP / envs.length; // relative to direct peak power
  const avg = new Float64Array(irN);
  for (const env of envs) for (let i = 0; i < irN; i++) avg[i] += env[i] / envs.length;

  // 2 ms moving average: smooths the pulse's fine structure but keeps reflections separate
  const sm = Math.max(1, Math.round(0.002 * fs));
  const smooth = new Float64Array(irN);
  let acc = 0;
  for (let i = 0; i < irN; i++) {
    acc += avg[i];
    if (i >= sm) acc -= avg[i - sm];
    smooth[i] = acc / Math.min(i + 1, sm);
  }
  // truncation point (simplified Lundeby): where the smoothed envelope first sinks to 2× the noise
  let trunc = irN;
  for (let i = lead; i < irN; i++) {
    if (smooth[i] < 2 * noise) { trunc = i; break; }
  }
  // Schroeder backward integration of the noise-subtracted envelope
  const edcLin = new Float64Array(irN);
  let s = 0;
  for (let i = trunc - 1; i >= 0; i--) {
    s += Math.max(0, avg[i] - noise);
    edcLin[i] = s;
  }
  const e0 = edcLin[lead];
  const edcDb = (i: number) => 10 * Math.log10(Math.max(edcLin[i] / e0, 1e-12));
  const fitBetween = (hi: number, lo: number): number | null => {
    const xs: number[] = [], ys: number[] = [];
    let reached = false;
    for (let i = lead; i < trunc; i++) {
      const d = edcDb(i);
      if (d <= lo) { reached = true; break; }
      if (d <= hi) { xs.push((i - lead) / fs); ys.push(d); }
    }
    if (!reached || xs.length < 4) return null;
    const f = linfit(xs, ys);
    return f.b < 0 ? -60 / f.b : null;
  };
  const lastAbove = (db: number): number | null => {
    const thr = Math.pow(10, db / 10);
    if (noise * 2 > thr) return null; // noise floor hides this level
    let last = lead;
    for (let i = lead; i < trunc; i++) if (smooth[i] >= thr) last = i;
    return round((last - lead) / fs, 4);
  };
  const dW = Math.round(0.0025 * fs);
  let direct = 0, rev = 0;
  for (let i = 0; i < trunc; i++) {
    const v = Math.max(0, avg[i] - noise);
    if (Math.abs(i - lead) <= dW) direct += v;
    else if (i > lead) rev += v;
  }
  const edc: { t: number; db: number }[] = [];
  for (let i = lead; i < trunc; i += Math.round(0.005 * fs)) edc.push({ t: round((i - lead) / fs, 3), db: round(edcDb(i), 1) });
  const envelope: { t: number; db: number }[] = [];
  for (let i = 0; i < irN; i += Math.round(0.002 * fs)) envelope.push({ t: round((i - lead) / fs, 3), db: round(10 * Math.log10(Math.max(smooth[i], 1e-12)), 1) });

  const rt30 = fitBetween(-5, -35);
  const rt20 = fitBetween(-5, -25);
  const edt = fitBetween(0, -10);
  const drrDb = 10 * Math.log10(direct / Math.max(rev, 1e-12));
  const result: EchoResult = {
    test: 'echo',
    fs,
    markerTime: round(m.time, 4),
    burstsUsed: envs.length,
    peakToNoiseDb: round(-10 * Math.log10(noise), 1),
    edtSec: edt === null ? null : round(edt, 3),
    rt60FromT20: rt20 === null ? null : round(rt20, 3),
    rt60FromT30: rt30 === null ? null : round(rt30, 3),
    tMinus20: lastAbove(-20),
    tMinus30: lastAbove(-30),
    drrDb: round(drrDb, 1),
    edc,
    envelope,
  };
  // Scale so the direct pulse has unit gain at the band centre: convolving a modem signal with the
  // exported IR then reproduces the room's reverb relative to an unattenuated direct path.
  const wc = (Math.PI * (o.f0 + o.f1)) / fs;
  let gr = 0, gi = 0;
  for (let i = Math.max(0, lead - dW); i <= lead + dW; i++) {
    gr += bestIr[i] * Math.cos(wc * i);
    gi -= bestIr[i] * Math.sin(wc * i);
  }
  const g = Math.hypot(gr, gi) || 1;
  const ir: MeasuredIr = {
    fs,
    ir: Array.from(bestIr.subarray(0, Math.min(irN, trunc + Math.round(0.05 * fs))), (v) => round(v / g, 7)),
    meta: { kind: 'bench-echo', f0: o.f0, f1: o.f1, date: new Date().toISOString(), drrDb: result.drrDb, rt60: result.rt60FromT20 ?? result.rt60FromT30 },
  };
  return { result, ir };
}

/** Mean of a decay figure over several runs, ignoring nulls (for the summary table). */
export function meanOf(v: (number | null)[]): number | null {
  const x = v.filter((a): a is number => a !== null);
  return x.length ? mean(x) : null;
}
