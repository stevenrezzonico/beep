import { fft } from '../src/dsp/fft.ts';
import { hann } from '../src/dsp/spectrum.ts';
import { cssVar, setupCanvas } from './plot.ts';

/**
 * Live band-limited spectrum + scrolling spectrogram. Only the band of interest is drawn (default
 * 16–19 kHz, i.e. the modem band with a margin), with the band edges marked, so leakage and
 * interference near the band are obvious at a glance.
 */
export interface SpectrumViewOptions {
  fMin: number;
  fMax: number;
  fftSize: number;
  dbMin: number;
  dbMax: number;
  /** Vertical marker lines, Hz. */
  marks: number[];
}

export const SPECTRUM_DEFAULTS: SpectrumViewOptions = { fMin: 16000, fMax: 19000, fftSize: 4096, dbMin: -130, dbMax: -10, marks: [17000, 18500] };

export class SpectrumView {
  private readonly o: SpectrumViewOptions;
  private readonly ring: Float32Array;
  private write = 0;
  private fresh = false;
  private fs = 48000;
  private raf = 0;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly win: Float64Array;
  private readonly norm: number;
  private peakHold: Float64Array | null = null;
  private readonly spec: HTMLCanvasElement;
  private readonly sgram: HTMLCanvasElement | null;

  constructor(spec: HTMLCanvasElement, sgram: HTMLCanvasElement | null, o: Partial<SpectrumViewOptions> = {}) {
    this.spec = spec;
    this.sgram = sgram;
    this.o = { ...SPECTRUM_DEFAULTS, ...o };
    this.ring = new Float32Array(this.o.fftSize);
    this.re = new Float64Array(this.o.fftSize);
    this.im = new Float64Array(this.o.fftSize);
    this.win = hann(this.o.fftSize);
    const ws = this.win.reduce((a, b) => a + b, 0);
    this.norm = (ws / 2) ** 2; // full-scale sine reads 0 dBFS
  }

  push(samples: Float32Array, fs: number): void {
    this.fs = fs;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i];
      this.write = (this.write + 1) % this.ring.length;
    }
    this.fresh = true;
  }

  start(): void {
    if (this.raf) return;
    const loop = () => {
      if (this.fresh) {
        this.fresh = false;
        this.render();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resetPeak(): void {
    this.peakHold = null;
  }

  private render(): void {
    const n = this.o.fftSize;
    for (let i = 0; i < n; i++) {
      this.re[i] = this.ring[(this.write + i) % n] * this.win[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    const k0 = Math.max(0, Math.floor((this.o.fMin * n) / this.fs));
    const k1 = Math.min(n / 2, Math.ceil((this.o.fMax * n) / this.fs));
    const db = new Float64Array(k1 - k0 + 1);
    for (let k = k0; k <= k1; k++) db[k - k0] = 10 * Math.log10((this.re[k] ** 2 + this.im[k] ** 2) / this.norm + 1e-20);
    if (!this.peakHold || this.peakHold.length !== db.length) this.peakHold = db.slice();
    else for (let i = 0; i < db.length; i++) this.peakHold[i] = Math.max(this.peakHold[i] - 0.3, db[i]);
    const freqAt = (i: number) => ((k0 + i) * this.fs) / n;
    this.drawSpectrum(db, freqAt);
    if (this.sgram) this.drawColumn(db, freqAt);
  }

  private x(f: number, w: number): number {
    return ((f - this.o.fMin) / (this.o.fMax - this.o.fMin)) * w;
  }

  private drawSpectrum(db: Float64Array, freqAt: (i: number) => number): void {
    const { ctx: g, w, h } = setupCanvas(this.spec);
    const { dbMin, dbMax } = this.o;
    const y = (v: number) => h - ((Math.min(dbMax, Math.max(dbMin, v)) - dbMin) / (dbMax - dbMin)) * h;
    g.fillStyle = cssVar('--plot-bg');
    g.fillRect(0, 0, w, h);
    g.strokeStyle = cssVar('--grid');
    g.lineWidth = 1;
    g.fillStyle = cssVar('--muted');
    g.font = '11px system-ui, sans-serif';
    for (let v = Math.ceil(dbMin / 20) * 20; v <= dbMax; v += 20) {
      g.beginPath();
      g.moveTo(0, y(v));
      g.lineTo(w, y(v));
      g.stroke();
      g.fillText(`${v}`, 2, y(v) - 2);
    }
    for (let f = Math.ceil(this.o.fMin / 500) * 500; f <= this.o.fMax; f += 500) g.fillText(`${(f / 1000).toFixed(1)}k`, this.x(f, w) + 2, h - 3);
    g.strokeStyle = cssVar('--accent-2');
    g.setLineDash([4, 4]);
    for (const m of this.o.marks) {
      g.beginPath();
      g.moveTo(this.x(m, w), 0);
      g.lineTo(this.x(m, w), h);
      g.stroke();
    }
    g.setLineDash([]);
    const line = (d: Float64Array, color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let i = 0; i < d.length; i++) {
        const px = this.x(freqAt(i), w);
        if (i === 0) g.moveTo(px, y(d[i]));
        else g.lineTo(px, y(d[i]));
      }
      g.stroke();
    };
    if (this.peakHold) line(this.peakHold, cssVar('--muted'), 1);
    line(db, cssVar('--accent'), 1.5);
  }

  private drawColumn(db: Float64Array, freqAt: (i: number) => number): void {
    const c = this.sgram!;
    // spectrogram works in device pixels with an identity transform so the 1-px scroll is exact
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width * dpr));
    const H = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(c, -1, 0);
    const col = g.createImageData(1, H);
    const { dbMin, dbMax } = this.o;
    const df = freqAt(1) - freqAt(0);
    for (let py = 0; py < H; py++) {
      // frequency runs bottom → top
      const f = this.o.fMax - (py / H) * (this.o.fMax - this.o.fMin);
      const i = Math.round((f - freqAt(0)) / df);
      const v = db[Math.min(db.length - 1, Math.max(0, i))];
      const [r, gg, b] = heat(Math.min(1, Math.max(0, (v - dbMin) / (dbMax - dbMin))));
      col.data[4 * py] = r;
      col.data[4 * py + 1] = gg;
      col.data[4 * py + 2] = b;
      col.data[4 * py + 3] = 255;
    }
    g.putImageData(col, W - 1, 0);
  }
}

/** Perceptually ordered dark→bright ramp (works on both themes since it sits on its own canvas). */
function heat(t: number): [number, number, number] {
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.6 * t - 0.4)));
  const gg = Math.round(255 * Math.min(1, Math.max(0, 1.8 * t - 0.8)));
  const b = Math.round(255 * Math.min(1, Math.max(0, t < 0.5 ? 0.25 + 1.2 * t : 1.6 - 1.6 * t)));
  return [r, gg, b];
}
