/** Minimal dependency-free SVG line plot (log-y) for BER/PER curves in the docs. */
export interface Series {
  name: string;
  points: [number, number][];
}

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#65a30d', '#4b5563', '#ca8a04', '#7c3aed', '#059669', '#e11d48', '#0284c7', '#a16207', '#475569'];

export function svgPlot(title: string, xLabel: string, yLabel: string, series: Series[], yMin = 1e-4): string {
  const W = 760, H = 440, L = 60, R = 210, T = 36, B = 46;
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ly0 = Math.log10(yMin), ly1 = 0;
  const px = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const py = (y: number) => T + ((ly1 - Math.log10(Math.max(y, yMin))) / (ly1 - ly0)) * (H - T - B);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="12">`);
  out.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
  out.push(`<text x="${W / 2 - R / 2}" y="20" text-anchor="middle" font-size="14" font-weight="600">${esc(title)}</text>`);
  for (let e = Math.ceil(ly0); e <= ly1; e++) {
    const y = py(10 ** e);
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#e5e7eb"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">1e${e}</text>`);
  }
  const step = niceStep((x1 - x0) / 8);
  for (let x = Math.ceil(x0 / step) * step; x <= x1 + 1e-9; x += step) {
    const X = px(x);
    out.push(`<line x1="${X}" x2="${X}" y1="${T}" y2="${H - B}" stroke="#f3f4f6"/><text x="${X}" y="${H - B + 16}" text-anchor="middle">${+x.toFixed(1)}</text>`);
  }
  out.push(`<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">${esc(xLabel)}</text>`);
  out.push(`<text x="14" y="${(T + H - B) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(T + H - B) / 2})">${esc(yLabel)}</text>`);
  series.forEach((s, i) => {
    const c = COLORS[i % COLORS.length];
    const pts = s.points.filter((p) => p[1] > 0 || true).map((p) => `${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`);
    out.push(`<polyline fill="none" stroke="${c}" stroke-width="1.8" points="${pts.join(' ')}"/>`);
    const ly = T + 6 + i * 16;
    out.push(`<line x1="${W - R + 10}" x2="${W - R + 28}" y1="${ly}" y2="${ly}" stroke="${c}" stroke-width="2.5"/><text x="${W - R + 33}" y="${ly + 4}">${esc(s.name)}</text>`);
  });
  out.push('</svg>');
  return out.join('\n');
}

function niceStep(x: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
