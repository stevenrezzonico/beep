/**
 * Reed–Solomon over GF(256) (primitive polynomial 0x11d, first consecutive root α^0), systematic,
 * shortened to any n ≤ 255. Errors-and-erasures decoder (Berlekamp–Massey, Chien, Forney).
 * Used for the FEC comparison and available as an outer code; corrects (n−k)/2 byte errors.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gfMul(a: number, b: number): number {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}
export function gfDiv(a: number, b: number): number {
  if (!b) throw new Error('GF divide by zero');
  return a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0;
}
export function gfInv(a: number): number {
  return EXP[255 - LOG[a]];
}
export function gfPow(a: number, e: number): number {
  if (e === 0) return 1;
  if (!a) return 0;
  return EXP[(((LOG[a] * e) % 255) + 255) % 255];
}

const genCache = new Map<number, Uint8Array>();
function generator(nsym: number): Uint8Array {
  let g = genCache.get(nsym);
  if (g) return g;
  let p = Uint8Array.of(1);
  for (let i = 0; i < nsym; i++) {
    const q = new Uint8Array(p.length + 1);
    for (let j = 0; j < p.length; j++) {
      q[j] ^= p[j];
      q[j + 1] ^= gfMul(p[j], EXP[i]);
    }
    p = q;
  }
  genCache.set(nsym, p);
  return (g = p);
}

/** Systematic encode: returns data followed by nsym parity bytes. */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (data.length + nsym > 255) throw new Error('RS block too long');
  const g = generator(nsym);
  const buf = new Uint8Array(data.length + nsym);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const c = buf[i];
    if (c) for (let j = 1; j < g.length; j++) buf[i + j] ^= gfMul(g[j], c);
  }
  buf.set(data);
  return buf;
}

function polyEval(p: ArrayLike<number>, x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
}

/**
 * Decode in place. `erasures` are byte positions known to be unreliable. Returns the corrected
 * data (without parity) or null if uncorrectable.
 */
export function rsDecode(block: Uint8Array, nsym: number, erasures: number[] = []): { data: Uint8Array; corrected: number } | null {
  const n = block.length;
  const msg = Uint8Array.from(block);
  const synd = new Uint8Array(nsym);
  let any = false;
  for (let i = 0; i < nsym; i++) {
    synd[i] = polyEval(msg, EXP[i]);
    if (synd[i]) any = true;
  }
  if (!any) return { data: msg.subarray(0, n - nsym), corrected: 0 };
  if (erasures.length > nsym) return null;
  // erasure locator Γ(x) = Π (1 − X_j x), X_j = α^(n−1−pos); polynomials stored low-order first
  let gamma = [1];
  for (const pos of erasures) {
    const X = EXP[n - 1 - pos];
    const next = new Array(gamma.length + 1).fill(0);
    for (let i = 0; i < gamma.length; i++) {
      next[i] ^= gamma[i];
      next[i + 1] ^= gfMul(gamma[i], X);
    }
    gamma = next;
  }
  // syndromes low-order first: S(x) = Σ S_i x^i ; modified syndromes via Berlekamp–Massey init
  const S = Array.from(synd);
  let lambda = gamma.slice();
  let B = gamma.slice();
  let L = erasures.length;
  for (let r = erasures.length; r < nsym; r++) {
    let delta = 0;
    for (let i = 0; i < lambda.length; i++) if (r - i >= 0) delta ^= gfMul(lambda[i], S[r - i]);
    B = [0, ...B];
    if (delta) {
      if (2 * L <= r + erasures.length) {
        const T = lambda.slice();
        const nl = new Array(Math.max(lambda.length, B.length)).fill(0);
        for (let i = 0; i < nl.length; i++) nl[i] = (lambda[i] ?? 0) ^ gfMul(delta, B[i] ?? 0);
        lambda = nl;
        L = r + 1 + erasures.length - L;
        B = T.map((v) => gfDiv(v, delta));
      } else {
        const nl = new Array(Math.max(lambda.length, B.length)).fill(0);
        for (let i = 0; i < nl.length; i++) nl[i] = (lambda[i] ?? 0) ^ gfMul(delta, B[i] ?? 0);
        lambda = nl;
      }
    }
  }
  while (lambda.length > 1 && lambda[lambda.length - 1] === 0) lambda.pop();
  const nerr = lambda.length - 1;
  if (2 * (nerr - erasures.length) + erasures.length > nsym) return null;
  // Chien search: roots X^-1
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const Xinv = EXP[(255 - (n - 1 - i)) % 255];
    let v = 0;
    for (let j = lambda.length - 1; j >= 0; j--) v = gfMul(v, Xinv) ^ lambda[j];
    if (v === 0) pos.push(i);
  }
  if (pos.length !== nerr) return null;
  // error evaluator Ω(x) = S(x)Λ(x) mod x^nsym
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let j = 0; j < lambda.length && j <= i; j++) omega[i] ^= gfMul(S[i - j], lambda[j]);
  // Forney (first consecutive root α^0 ⇒ e = X·Ω(X^-1)/Λ'(X^-1))
  for (const p of pos) {
    const X = EXP[n - 1 - p];
    const Xinv = gfInv(X);
    let om = 0;
    for (let j = omega.length - 1; j >= 0; j--) om = gfMul(om, Xinv) ^ omega[j];
    let dl = 0;
    for (let j = 1; j < lambda.length; j += 2) dl ^= gfMul(lambda[j], gfPow(Xinv, j - 1));
    if (!dl) return null;
    msg[p] ^= gfMul(X, gfDiv(om, dl));
  }
  for (let i = 0; i < nsym; i++) if (polyEval(msg, EXP[i])) return null;
  return { data: msg.subarray(0, n - nsym), corrected: pos.length };
}
