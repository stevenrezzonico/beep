/** Tiny canvas line plot: enough for response curves, decay curves and time series. */

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/** Match the canvas backing store to its CSS size × devicePixelRatio. */
export function setupCanvas(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export interface Series {
  name: string;
  points: { x: number; y: number }[];
  color?: string;
  dashed?: boolean;
  /** Draw dots instead of a line. */
  dots?: boolean;
}

export interface PlotOptions {
  xLabel?: string;
  yLabel?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  vlines?: number[];
  hlines?: number[];
}

const PALETTE = ['--accent', '--accent-3', '--accent-4', '--accent-2'];

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export function linePlot(c: HTMLCanvasElement, series: Series[], o: PlotOptions = {}): void {
  c.classList.remove('hidden'); // plots start hidden until they have data
  const { ctx: g, w, h } = setupCanvas(c);
  const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const xMin = o.xMin ?? Math.min(...all.map((p) => p.x));
  const xMax = o.xMax ?? Math.max(...all.map((p) => p.x));
  let yMin = o.yMin ?? Math.min(...all.map((p) => p.y));
  let yMax = o.yMax ?? Math.max(...all.map((p) => p.y));
  if (!(yMax > yMin)) { yMin -= 1; yMax += 1; }
  const L = 40, R = 8, T = 8, B = 28;
  const px = (x: number) => L + ((x - xMin) / (xMax - xMin || 1)) * (w - L - R);
  const py = (y: number) => T + (1 - (y - yMin) / (yMax - yMin)) * (h - T - B);
  g.fillStyle = cssVar('--plot-bg');
  g.fillRect(0, 0, w, h);
  g.font = '11px system-ui, sans-serif';
  g.strokeStyle = cssVar('--grid');
  g.fillStyle = cssVar('--muted');
  g.lineWidth = 1;
  const ys = niceStep(yMax - yMin, 5);
  for (let v = Math.ceil(yMin / ys) * ys; v <= yMax + 1e-9; v += ys) {
    g.beginPath(); g.moveTo(L, py(v)); g.lineTo(w - R, py(v)); g.stroke();
    g.fillText(fmt(v), 2, py(v) + 4);
  }
  const xs = niceStep(xMax - xMin, Math.max(3, Math.floor(w / 80)));
  for (let v = Math.ceil(xMin / xs) * xs; v <= xMax + 1e-9; v += xs) {
    g.beginPath(); g.moveTo(px(v), T); g.lineTo(px(v), h - B); g.stroke();
    g.fillText(fmt(v), px(v) - 10, h - B + 13);
  }
  if (o.xLabel) g.fillText(o.xLabel, w - R - g.measureText(o.xLabel).width, h - 2);
  if (o.yLabel) g.fillText(o.yLabel, L + 4, T + 10);
  g.strokeStyle = cssVar('--accent-2');
  g.setLineDash([4, 4]);
  for (const v of o.vlines ?? []) { g.beginPath(); g.moveTo(px(v), T); g.lineTo(px(v), h - B); g.stroke(); }
  for (const v of o.hlines ?? []) { g.beginPath(); g.moveTo(L, py(v)); g.lineTo(w - R, py(v)); g.stroke(); }
  g.setLineDash([]);
  series.forEach((s, i) => {
    const color = s.color ?? cssVar(PALETTE[i % PALETTE.length]);
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.5;
    g.setLineDash(s.dashed ? [5, 3] : []);
    const pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (s.dots) {
      for (const p of pts) { g.beginPath(); g.arc(px(p.x), py(Math.min(yMax, Math.max(yMin, p.y))), 3, 0, 2 * Math.PI); g.fill(); }
    } else {
      g.beginPath();
      pts.forEach((p, j) => {
        const Y = py(Math.min(yMax, Math.max(yMin, p.y)));
        if (j === 0) g.moveTo(px(p.x), Y); else g.lineTo(px(p.x), Y);
      });
      g.stroke();
    }
  });
  g.setLineDash([]);
  // legend
  let lx = L + 6;
  series.forEach((s, i) => {
    if (series.length < 2) return;
    g.fillStyle = s.color ?? cssVar(PALETTE[i % PALETTE.length]);
    g.fillRect(lx, T + 16, 10, 3);
    g.fillStyle = cssVar('--muted');
    g.fillText(s.name, lx + 14, T + 21);
    lx += g.measureText(s.name).width + 28;
  });
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return `${(v / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  if (a >= 10 || v === 0) return v.toFixed(0);
  return v.toFixed(a >= 1 ? 1 : 2);
}
