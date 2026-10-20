import { bandInfo } from './band.ts';
import { Baseband } from './baseband.ts';
import { dechirpFft, type ChirpKind } from './css.ts';
import { decodeHeader, decodePayload, payloadSymbolCount, payloadSymbols, type PhyHeader } from './frame.ts';
import { DEFAULT_CONFIG, profileById, type ModemConfig, type Profile } from './profiles.ts';
import { grayEncode } from './gray.ts';
import { mAryLlr } from './candidates/types.ts';

/**
 * Streaming CSS receiver. Feed it microphone samples in chunks of any size; it emits events.
 *
 * Pipeline: band-pass/downconvert (Baseband) → preamble search on a fixed window grid →
 * up/down-chirp sync (CFO and timing separated, 3-hypothesis boundary check) → PHY header →
 * payload with a decision-directed tracking loop → Viterbi → CRC.
 *
 * Determinism: every decision is a function of baseband samples at absolute times on the
 * stream's own clock, and the downconverter is chunk-invariant, so the same input always yields
 * the same events regardless of how it was chunked (tested).
 *
 * Level independence (the "AGC"): detection uses peak-to-mean ratios within each FFT and every
 * symbol's spectrum is normalised by its own noise estimate before soft decisions, so absolute
 * level, slow gain changes (e.g. an AGC the browser would not disable) and the noise floor cancel
 * out. Thresholds derive from a target false-alarm probability, not from a level.
 */

export type RxState = 'search' | 'sync' | 'header' | 'payload';

export interface PacketDiag {
  /** Receiver-clock time of the up→down boundary of the preamble (s). */
  syncTime: number;
  profile: string;
  length: number;
  /** Carrier offset estimated from the preamble (Hz) and at the end of the packet. */
  cfoHz: number;
  cfoEndHz: number;
  /** Time-scale factor (Doppler + clock), ppm, and equivalent radial velocity (m/s). */
  scalePpm: number;
  velocity: number;
  /** Mean in-band SNR estimate over the packet, dB in the 1.5 kHz reference band. */
  snrDb: number;
  /** Header evidence over its acceptance threshold, dB. */
  headerMargin: number;
  /** Coded payload bits whose raw decision was corrected by the FEC. */
  correctedBits: number;
  codedBits: number;
  /** Payload symbols whose argmax disagreed with the re-encoded codeword (≈ symbol errors). */
  symbolErrors: number;
  symbols: number;
  /** Cumulative timing correction applied by the tracking loop (ms). */
  timingTrackMs: number;
  /** Air time of the packet (s). */
  duration: number;
}

export type RxEvent =
  | { type: 'detect'; time: number; ratioDb: number }
  | { type: 'sync'; time: number; cfoHz: number; score: number }
  | { type: 'sync-fail'; time: number; reason: string }
  | { type: 'header-fail'; time: number; margin: number; reason: string }
  | { type: 'header'; time: number; header: PhyHeader; profile: string }
  | { type: 'packet'; ok: true; data: Uint8Array; diag: PacketDiag }
  | { type: 'packet'; ok: false; data: null; diag: PacketDiag };

/** Gamma(n,1) upper tail Q(n, x) = e^{−x} Σ_{i<n} x^i/i!. */
function gammaQ(n: number, x: number): number {
  let term = 1, sum = 1;
  for (let i = 1; i < n; i++) {
    term *= x / i;
    sum += term;
  }
  return Math.exp(-x) * sum;
}

/** Threshold x such that bins·Q(n, x) = pfa. */
export function cfarThreshold(n: number, bins: number, pfa: number): number {
  let lo = n, hi = n + 400;
  for (let it = 0; it < 100; it++) {
    const mid = (lo + hi) / 2;
    if (bins * gammaQ(n, mid) > pfa) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Fractional position of a spectral peak from three complex bins (Jacobsen estimator), in
 * [−0.5, 0.5] bins; positive means the true frequency is above bin b.
 */
export function fracPeak(re: Float64Array, im: Float64Array, b: number): number {
  const N = re.length;
  const l = (b - 1 + N) % N, r = (b + 1) % N;
  // num = X[l] − X[r], den = 2X[b] − X[l] − X[r]; δ = Re(num/den)
  const nr = re[l] - re[r], ni = im[l] - im[r];
  const dr = 2 * re[b] - re[l] - re[r], di = 2 * im[b] - im[l] - im[r];
  const den = dr * dr + di * di;
  if (den === 0) return 0;
  const d = (nr * dr + ni * di) / den;
  return Math.max(-0.5, Math.min(0.5, d));
}

const SOUND = 343;
/** Largest radial speed the sync search allows for (m/s): a brisk walk towards the other device. */
const MAX_VELOCITY = 2;
/**
 * A post-detection window counts as "still up-chirp" if its peak is ≥ 4× the bin mean (6 dB);
 * noise alone exceeds that in one of N bins with probability N·e^{-4} (≈ 5 at SF8), so the ±1-bin
 * agreement with the detected bin is what makes it selective (≈3/N·N·e^{-4} ≈ 5%).
 */
const UP_AGREE_RATIO = 4;

/** Window's own argmax lies within ±1 bin of b. */
function agreesWith(pw: Float64Array, b: number): boolean {
  const N = pw.length;
  const m = argmax(pw);
  return Math.min((m - b + N) % N, (b - m + N) % N) <= 1;
}

interface SymbolResult {
  power: Float64Array; // normalised by its own noise mean
  peak: number;
  ratio: number; // peak / noise mean (linear)
  frac: number;
}

export class Receiver {
  readonly fs: number;
  readonly cfg: ModemConfig;
  private readonly bb: Baseband;
  private readonly bw: number;
  private readonly fc: number;
  private readonly Npre: number;
  private readonly TsPre: number;
  private readonly thrDet: number;
  private readonly thrHeader: number;
  state: RxState = 'search';
  private events: RxEvent[] = [];

  // search
  private gridOrigin = 0;
  private w = 0;
  private hist: { pw: Float64Array; re: Float64Array; im: Float64Array; t: number }[] = [];
  /** Latest detection statistic (dB above threshold-normalised mean) for UI meters. */
  lastRatioDb = 0;

  // sync
  private bUp = 0;
  /** Up-chirp windows that showed the detected peak: grid time and fractional peak bin. */
  private bUpWins: { t: number; b: number }[] = [];
  private detT = 0;

  // packet
  private tNext = 0;
  private cfoHz = 0;
  private cfoHz0 = 0;
  private eps = 0;
  private syncTime = 0;
  private hdrSyms: SymbolResult[] = [];
  private paySyms: SymbolResult[] = [];
  private header: PhyHeader | null = null;
  private profile: Profile | null = null;
  private headerMargin = 0;
  private trackT = 0;
  private nuEps = 0;

  // scratch
  private zr: Float64Array;
  private zi: Float64Array;
  private fr: Float64Array;
  private fi: Float64Array;

  constructor(fs: number, cfg: ModemConfig = DEFAULT_CONFIG) {
    this.fs = fs;
    this.cfg = cfg;
    const b = bandInfo(cfg.band);
    this.bw = b.bw;
    this.fc = b.fc;
    this.bb = new Baseband(fs, cfg.band);
    this.Npre = 1 << cfg.sfPre;
    this.TsPre = this.Npre / this.bw;
    // detection: sum over K windows of adjacent-bin pairs → Gamma(2K) under noise
    this.thrDet = cfarThreshold(2 * cfg.detWindows, this.Npre, cfg.pfa);
    // header: the ML codeword's summed bin powers vs the best of 4096 codewords under noise
    // (≈ Gamma(n) maximised over 4096 candidates), false accept 1e-4 per sync
    this.thrHeader = cfarThreshold(cfg.nHeader, 1 << 12, 1e-4);
    const maxN = 1 << Math.max(cfg.sfPre, ...cfg.profiles.map((p) => p.sf));
    this.zr = new Float64Array(maxN);
    this.zi = new Float64Array(maxN);
    this.fr = new Float64Array(maxN);
    this.fi = new Float64Array(maxN);
  }

  /** Detection threshold in dB (peak-pair power over mean bin power), for display. */
  get detectionThresholdDb(): number {
    return 10 * Math.log10(this.thrDet / (2 * this.cfg.detWindows));
  }

  push(x: ArrayLike<number>): RxEvent[] {
    this.bb.push(x);
    this.run();
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Flush the filters with silence (end of a recording). */
  flush(): RxEvent[] {
    return this.push(new Float32Array(Math.ceil(this.fs * (this.TsPre * 3 + 0.1))));
  }

  // ------------------------------------------------------------------ helpers

  /** Dechirped spectrum of N chips starting at t with chip spacing dt; returns into fr/fi. */
  private window(t: number, sf: number, kind: ChirpKind, dt: number, cfoBins: number): void {
    const N = 1 << sf;
    const zr = this.zr.subarray(0, N), zi = this.zi.subarray(0, N);
    this.bb.sample(t, dt, N, zr, zi);
    dechirpFft(zr, zi, sf, kind, this.fr.subarray(0, N), this.fi.subarray(0, N), cfoBins);
  }

  private power(N: number): Float64Array {
    const p = new Float64Array(N);
    for (let k = 0; k < N; k++) p[k] = this.fr[k] * this.fr[k] + this.fi[k] * this.fi[k];
    return p;
  }

  private ready(t: number): boolean {
    return this.bb.endTime >= t;
  }

  private run(): void {
    for (let guard = 0; guard < 100000; guard++) {
      const progressed =
        this.state === 'search' ? this.stepSearch() : this.state === 'sync' ? this.stepSync() : this.state === 'header' ? this.stepHeader() : this.stepPayload();
      if (!progressed) break;
    }
  }

  private toSearch(origin: number): void {
    this.state = 'search';
    this.gridOrigin = origin;
    this.w = 0;
    this.hist = [];
  }

  // ------------------------------------------------------------------ search

  private stepSearch(): boolean {
    const N = this.Npre;
    const t = this.gridOrigin + this.w * this.TsPre;
    if (!this.ready(t + this.TsPre)) return false;
    this.bb.discardBefore(t - (this.cfg.nUp + 4) * this.TsPre);
    this.window(t, this.cfg.sfPre, 'up', 1 / this.bw, 0);
    this.hist.push({ pw: this.power(N), re: this.fr.slice(0, N), im: this.fi.slice(0, N), t });
    if (this.hist.length > this.cfg.detWindows) this.hist.shift();
    this.w++;
    if (this.hist.length < this.cfg.detWindows) return true;
    const K = this.hist.length;
    const S2 = new Float64Array(N);
    for (const h of this.hist) for (let b = 0; b < N; b++) S2[b] += h.pw[b] + h.pw[(b + 1) % N];
    let best = 0, sum = 0;
    for (let b = 0; b < N; b++) {
      sum += S2[b];
      if (S2[b] > S2[best]) best = b;
    }
    // noise mean excluding the peak neighbourhood
    let ex = 0;
    for (let d = -2; d <= 2; d++) ex += S2[(best + d + N) % N];
    const mu = (sum - ex) / (N - 5) / (2 * K);
    // Exact digital silence (a muted or interrupted mic track delivers zeros) gives 0/0: treat it as
    // "nothing here" rather than letting NaN slip past the comparison and trigger every window.
    const stat = mu > 0 ? S2[best] / mu : 0;
    this.lastRatioDb = stat > 0 ? 10 * Math.log10(stat / this.thrDet) : -Infinity;
    if (!(stat >= this.thrDet)) return true;
    // the peak pair (best, best+1): pick the stronger bin as integer estimate
    let b = this.hist.reduce((a, h) => a + h.pw[best], 0) >= this.hist.reduce((a, h) => a + h.pw[(best + 1) % N], 0) ? best : (best + 1) % N;
    // consistency: at least two windows individually peak within ±1 bin of b
    if (this.hist.filter((h) => agreesWith(h.pw, b)).length < 2) return true;
    this.events.push({ type: 'detect', time: t, ratioDb: this.lastRatioDb });
    this.bUp = b;
    // fractional estimate only from windows that individually show the peak (others may be noise)
    this.bUpWins = this.hist.filter((h) => agreesWith(h.pw, b)).map((h) => ({ t: h.t, b: this.refine(h.re, h.im, h.pw, b) }));
    this.detT = t + this.TsPre;
    this.state = 'sync';
    return true;
  }

  /** Fractional bin position near integer bin b (searches b±1 for the local max first). */
  private refine(re: Float64Array, im: Float64Array, pw: Float64Array, b: number): number {
    const N = re.length;
    let m = b;
    for (const c of [(b - 1 + N) % N, (b + 1) % N]) if (pw[c] > pw[m]) m = c;
    let off = (m - b + N) % N;
    if (off > N / 2) off -= N;
    return b + off + fracPeak(re, im, m);
  }

  // ------------------------------------------------------------------ sync

  /**
   * Joint CFO/boundary search. The up-chirps fix b_up = Δ − d (mod N) but not Δ (carrier offset)
   * and d (symbol boundary) separately. For every carrier-offset hypothesis Δ0 on a ¼-bin grid
   * within ±maxVelocity, the boundary is then known modulo Ts, and for each candidate boundary
   * B we score three aligned, de-rotated windows at their expected bin 0: the last up-chirp
   * (B−Ts) and the two full down-chirps (B, B+Ts). Using aligned windows at a known bin, rather
   * than first detecting the down-chirps on the unaligned grid, spends all of their energy on the
   * decision. The threshold follows from the number of hypotheses tested (false-alarm 1e-3).
   */
  private stepSync(): boolean {
    const N = this.Npre;
    const Ts = this.TsPre;
    const tLast = this.detT - Ts; // start of the last detection window
    // At good SNR the detector fires as soon as one or two windows hold preamble, so the up→down
    // boundary may still be up to nUp symbols ahead.
    const span = this.cfg.nUp + 1;
    if (!this.ready(tLast + (span + this.cfg.nDown + 1) * Ts)) return false;
    // refine b_up with the grid windows that follow the detection and still show the up-peak
    for (let i = 1; i <= this.cfg.nUp; i++) {
      this.window(tLast + i * Ts, this.cfg.sfPre, 'up', 1 / this.bw, 0);
      const p = this.power(N);
      const m = argmax(p);
      const dd = Math.min((m - this.bUp + N) % N, (this.bUp - m + N) % N);
      let mu = 0;
      for (let k = 0; k < N; k++) mu += p[k];
      if (dd <= 1 && p[m] / (mu / N) > UP_AGREE_RATIO) this.bUpWins.push({ t: tLast + i * Ts, b: this.refine(this.fr.slice(0, N), this.fi.slice(0, N), p, this.bUp) });
    }
    const dMax = Math.ceil((MAX_VELOCITY / SOUND) * this.fc * Ts);
    const lim = tLast + (span + 0.5) * Ts;
    // Doppler and clock offset are a time scaling 1+ε of the whole signal, so each carrier
    // hypothesis Δ0 implies ε0 = Δ0/(fc·Ts): windows are spaced Ts/(1+ε0) and sampled at the scaled
    // chip rate, otherwise the boundary drifts ε·N chips per symbol across the preamble and biases
    // the estimate. On the unscaled detection grid the up-peak sits at Δ·f1/fc − d; each agreeing
    // window then implies a boundary phase modulo the scaled period, combined by circular mean.
    const geometry = (delta: number) => {
      const P = Ts / (1 + delta / (this.fc * Ts));
      let cr = 0, ci = 0;
      for (const w of this.bUpWins) {
        const d = mod((delta * (this.fc + this.bw / 2)) / this.fc - w.b, N);
        const ph = (2 * Math.PI * mod(w.t + d / this.bw - tLast, P)) / P;
        cr += Math.cos(ph);
        ci += Math.sin(ph);
      }
      return { P, phase: mod((Math.atan2(ci, cr) / (2 * Math.PI)) * P, P) };
    };
    // Score = all aligned up-chirps before B + all down-chirps after it. Adjacent boundary
    // hypotheses then differ by about two full symbols of evidence (one up, one down), not by the
    // difference of two noisy windows.
    const score = (delta: number, B: number, P: number) => {
      let up = 0, down = 0;
      for (let k = 1; k < this.cfg.nUp; k++) up += this.alignedPeak(B - k * P, 'up', delta);
      for (let k = 0; k < this.cfg.nDown; k++) down += this.alignedPeak(B + k * P, 'down', delta);
      return { up, down };
    };
    // Coarse pass (Δ0 = 0 geometry): for each candidate boundary the summed down-chirp spectrum
    // peaks near bin Δ·(1 + f1/fc) — the misalignment and the carrier offset add up — which gives
    // the carrier offset directly instead of scoring every Δ0 separately (≈100× fewer FFTs).
    // At low SNR detection may fire only once the last window already holds down-chirp energy, so
    // the boundary can also lie up to two symbols before the last detection window.
    const kDelta = 1 + (this.fc + this.bw / 2) / this.fc;
    const pMax = Math.ceil(kDelta * dMax) + 1;
    const coarsePass = (guess: number, range: number) => {
      const g = geometry(guess);
      const sc = 1 + guess / (this.fc * Ts);
      let c = { score: -1, B: 0, delta: guess };
      for (let j = -2; j <= span; j++) {
        const B = tLast + g.phase + j * g.P;
        if (B > lim) continue;
        let up = 0;
        for (let k = 1; k < this.cfg.nUp; k++) up += this.alignedPeak(B - k * g.P, 'up', guess);
        const S = new Float64Array(N);
        for (let k = 0; k < this.cfg.nDown; k++) {
          this.window(B + k * g.P, this.cfg.sfPre, 'down', 1 / (this.bw * sc), guess / sc);
          const pw = this.power(N);
          let mu = 0;
          for (let i = 0; i < N; i++) mu += pw[i];
          for (let i = 0; i < N; i++) S[i] += (pw[i] * N) / mu;
        }
        for (let p = -range; p <= range; p++) {
          const v = S[mod(p, N)] + S[mod(p + 1, N)];
          const pk = S[mod(p, N)] >= S[mod(p + 1, N)] ? p : p + 1;
          if (up + v > c.score) c = { score: up + v, B, delta: guess + pk / kDelta };
        }
      }
      return c;
    };
    // second pass re-centred on the first estimate, so its windows use the right time scale
    const c1 = coarsePass(0, pMax);
    const coarse = coarsePass(Math.max(-dMax, Math.min(dMax, Math.round(c1.delta * 4) / 4)), 8);
    // Fine pass: exact aligned, time-scaled scoring on a ¼-bin grid around the coarse estimate
    // (the down-chirp peak moves by 2·(Δ−Δ0), so ¼ bin keeps the scalloping loss ≤ 0.9 dB).
    let best = { score: -1, down: 0, B: 0, delta: 0 };
    const dc = Math.round(coarse.delta * 4) / 4;
    for (let delta = dc - 1.5; delta <= dc + 1.5; delta += 0.25) {
      if (Math.abs(delta) > dMax) continue;
      const g = geometry(delta);
      // the boundary under this hypothesis nearest the coarse one, and its neighbours
      const j0 = Math.round((coarse.B - tLast - g.phase) / g.P);
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const B = tLast + g.phase + j * g.P;
        if (B > lim) continue;
        const { up, down } = score(delta, B, g.P);
        if (up + down > best.score) best = { score: up + down, down, B, delta };
      }
    }
    // the threshold accounts for the full hypothesis space the coarse pass searched
    const tests = (Math.floor((2 * dMax) / 0.25) + 1) * (span + 3);
    // validation on the down-chirps alone (the up-chirps already passed detection): nDown windows,
    // best of 3 bins each (3^nDown bin choices), union bound over all hypotheses, false alarm 1e-3
    const thr = cfarThreshold(this.cfg.nDown, 3 ** this.cfg.nDown * Math.max(1, tests), 1e-3);
    if (best.down < thr) {
      this.events.push({ type: 'sync-fail', time: tLast, reason: 'no down-chirp match' });
      this.toSearch(tLast + Ts);
      return true;
    }
    // refinement on every aligned preamble window: up-chirps give Δ−δd, down-chirps Δ+δd
    let delta = best.delta;
    let B = best.B;
    for (let it = 0; it < 2; it++) {
      const sc = 1 + delta / (this.fc * Ts);
      const ups: number[] = [];
      for (let k = 1; k <= this.cfg.nUp - 1; k++) ups.push(this.alignedFrac(B - (k * Ts) / sc, 'up', delta));
      const downs: number[] = [];
      for (let k = 0; k < this.cfg.nDown; k++) downs.push(this.alignedFrac(B + (k * Ts) / sc, 'down', delta));
      const ru = median(ups);
      const rd = median(downs);
      delta += (ru + rd) / 2;
      B += (rd - ru) / 2 / this.bw;
    }
    this.cfoHz = (delta * this.bw) / N;
    this.cfoHz0 = this.cfoHz;
    this.eps = this.cfoHz / this.fc;
    this.nuEps = 0;
    this.trackT = 0;
    this.syncTime = B;
    this.tNext = B + (this.cfg.nDown * Ts) / (1 + this.eps);
    this.hdrSyms = [];
    this.paySyms = [];
    this.events.push({ type: 'sync', time: B, cfoHz: this.cfoHz, score: 10 * Math.log10(best.down / this.cfg.nDown) });
    this.state = 'header';
    return true;
  }

  /**
   * Best of bins {−1,0,1} of a window aligned at B over the window mean. The carrier offset
   * Δ (preamble bins) is removed and the chips are sampled on the time scale it implies.
   */
  private alignedPeak(B: number, kind: ChirpKind, deltaBins: number): number {
    const N = this.Npre;
    const sc = 1 + deltaBins / (this.fc * this.TsPre);
    this.window(B, this.cfg.sfPre, kind, 1 / (this.bw * sc), deltaBins / sc);
    const p = this.power(N);
    let mu = 0;
    for (let k = 0; k < N; k++) mu += p[k];
    mu /= N;
    return Math.max(p[0], p[1], p[N - 1]) / mu;
  }

  private alignedFrac(B: number, kind: ChirpKind, deltaBins: number): number {
    const N = this.Npre;
    const sc = 1 + deltaBins / (this.fc * this.TsPre);
    this.window(B, this.cfg.sfPre, kind, 1 / (this.bw * sc), deltaBins / sc);
    const p = this.power(N);
    const r = this.refine(this.fr.slice(0, N), this.fi.slice(0, N), p, 0);
    return r > N / 2 ? r - N : r;
  }

  // ------------------------------------------------------------------ symbols

  /** Demodulate one tracked symbol at SF sf; advances tNext and updates the tracking loop. */
  private demodSymbol(sf: number): SymbolResult {
    const N = 1 << sf;
    const Ts = N / this.bw / (1 + this.eps);
    const dt = Ts / N;
    this.window(this.tNext, sf, 'up', dt, this.cfoHz * Ts);
    const p = this.power(N);
    const m = argmax(p);
    // noise mean excluding the peak and its immediate sidelobes (fractional offsets leak there)
    let mu = 0;
    for (let k = 0; k < N; k++) mu += p[k];
    for (let d = -2; d <= 2; d++) mu -= p[(m + d + N) % N];
    mu /= N - 5;
    const ratio = p[m] / mu;
    const r = fracPeak(this.fr.subarray(0, N) as Float64Array, this.fi.subarray(0, N) as Float64Array, m);
    for (let k = 0; k < N; k++) p[k] /= mu;
    // Tracking: type-2 loop on the residual bin offset r. The proportional path corrects the
    // carrier (de-rotation), the integral path the time-scale ε, so window timing follows
    // Doppler/clock drift. Only confident decisions update it (peak ≥ 4·ln N × noise mean: a
    // noise bin exceeds that with probability ≈ N·N^-4 per symbol), because a wrong decision
    // carries a random fractional offset. Gains: D-012.
    if (ratio > 4 * Math.log(N)) {
      this.cfoHz += (this.cfg.trackP * r) / Ts;
      this.nuEps += (this.cfg.trackI * r) / N;
      this.eps += (this.cfg.trackI * r) / N;
    }
    this.tNext += Ts;
    this.trackT += Ts * this.nuEps;
    return { power: p, peak: m, ratio, frac: r };
  }

  private stepHeader(): boolean {
    const n = this.cfg.nHeader;
    const sf = this.cfg.sfPre;
    const Ts = (1 << sf) / this.bw;
    if (!this.ready(this.tNext + Ts * 1.01)) return false;
    this.hdrSyms.push(this.demodSymbol(sf));
    if (this.hdrSyms.length < n) return true;
    // signal energy per symbol from the preamble-calibrated peaks of the header symbols themselves
    const es = this.hdrSyms.reduce((a, x) => a + Math.max(x.power[x.peak] - 1, 1e-3), 0) / n;
    const h = decodeHeader(
      this.hdrSyms.map((x) => x.power),
      sf,
      n,
      es,
      this.thrHeader,
    );
    this.headerMargin = 10 * Math.log10(h.evidence / h.threshold);
    const prof = h.header ? profileById(this.cfg, h.header.profile) : undefined;
    if (!h.header || !prof) {
      this.events.push({ type: 'header-fail', time: this.syncTime, margin: this.headerMargin, reason: h.reason ?? 'unknown profile' });
      this.toSearch(this.tNext);
      return true;
    }
    this.header = h.header;
    this.profile = prof;
    this.events.push({ type: 'header', time: this.syncTime, header: h.header, profile: prof.name });
    this.state = 'payload';
    return true;
  }

  private stepPayload(): boolean {
    const p = this.profile!;
    const h = this.header!;
    const n = payloadSymbolCount(h.length, p.sf, p.rate);
    const Ts = (1 << p.sf) / this.bw;
    if (!this.ready(this.tNext + Ts * 1.01)) return false;
    this.paySyms.push(this.demodSymbol(p.sf));
    this.bb.discardBefore(this.tNext - 2 * this.TsPre);
    if (this.paySyms.length < n) return true;
    const llr = softBits(this.paySyms, p.sf);
    const dec = decodePayload(h, llr, p.rate);
    // symbol errors: compare argmax to the re-encoded symbols (only meaningful if CRC passed)
    let symErr = 0;
    if (dec.data) {
      const ref = reencodeSymbols(h, dec.data, p);
      for (let i = 0; i < n; i++) if (ref[i] !== this.paySyms[i].peak) symErr++;
    }
    const all = [...this.hdrSyms, ...this.paySyms];
    const snrLin = all.reduce((a, s) => a + Math.max(s.ratio - 1, 1e-3) / s.power.length, 0) / all.length;
    const diag: PacketDiag = {
      syncTime: this.syncTime,
      profile: p.name,
      length: h.length,
      cfoHz: this.cfoHz0,
      cfoEndHz: this.cfoHz,
      scalePpm: this.eps * 1e6,
      velocity: this.eps * SOUND,
      // Es/N0 per bin / N = SNR in the occupied band; convert to the 1.5 kHz reference band
      snrDb: 10 * Math.log10(snrLin * (this.bw / (this.cfg.band.fHigh - this.cfg.band.fLow))),
      headerMargin: this.headerMargin,
      correctedBits: dec.correctedBits,
      codedBits: dec.codedBits,
      symbolErrors: symErr,
      symbols: n,
      timingTrackMs: this.trackT * 1000,
      duration: this.tNext - this.syncTime + this.TsPre * this.cfg.nUp,
    };
    if (dec.data) this.events.push({ type: 'packet', ok: true, data: dec.data, diag });
    else this.events.push({ type: 'packet', ok: false, data: null, diag });
    this.toSearch(this.tNext);
    return true;
  }
}

function reencodeSymbols(h: PhyHeader, data: Uint8Array, p: Profile): number[] {
  return payloadSymbols(h, data, p.sf, p.rate);
}

/** LLRs from normalised symbol spectra (noise mean = 1 per bin). */
function softBits(syms: SymbolResult[], sf: number): Float64Array {
  let es = 0;
  for (const s of syms) es += Math.max(s.power[s.peak] - 1, 1e-3);
  es /= syms.length;
  const out: number[] = [];
  for (const s of syms) mAryLlr(s.power, sf, es, 1, grayEncode, out);
  return Float64Array.from(out);
}

function argmax(p: ArrayLike<number>): number {
  let m = 0;
  for (let k = 1; k < p.length; k++) if (p[k] > p[m]) m = k;
  return m;
}

/** Median (robust against a window that straddled the end of the up-chirp run). */
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mod(x: number, n: number): number {
  return ((x % n) + n) % n;
}


