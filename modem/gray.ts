/** Binary-reflected Gray code: adjacent symbol values differ in one bit, so the most likely
 *  demodulation error (±1 bin from residual frequency/timing offset) costs one bit, not several. */
export function grayEncode(v: number): number {
  return v ^ (v >>> 1);
}

export function grayDecode(g: number): number {
  let v = g;
  for (let s = g >>> 1; s; s >>>= 1) v ^= s;
  return v;
}
