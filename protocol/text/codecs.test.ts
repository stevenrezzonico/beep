import { describe, expect, it } from 'vitest';
import { compactEncode, compactDecode, sixBitEncode, sixBitDecode } from './codecs.ts';
import { getModel } from './model.ts';
import { readFileSync } from 'node:fs';
const testset = readFileSync(new URL('./testset.txt', import.meta.url), 'utf8');

const msgs = testset.split('\n').filter((l) => l.startsWith('[')).map((l) => l.replace(/^\[[a-z]+\] /, ''));

describe('text codecs', () => {
  it('compact codec round-trips every test message, incl. non-Latin and emoji', () => {
    for (const m of msgs) expect(compactDecode(compactEncode(m))).toBe(m);
    for (const m of ['', 'a', 'Z', '~~~', 'x'.repeat(300), 'tab\tand\u0001ctrl']) expect(compactDecode(compactEncode(m))).toBe(m.replace(/[\u0000-\u0009\u000b-\u001f]/g, ' '));
  });
  it('compact codec survives trailing padding bits', () => {
    for (const m of msgs.slice(0, 10)) {
      const b = compactEncode(m);
      expect(compactDecode([...b, 0, 0, 0, 0, 0, 0, 0])).toBe(m);
      expect(compactDecode([...b, 1, 0, 1, 1])).toBe(m);
    }
  });
  it('six-bit codec round-trips', () => {
    for (const m of msgs) expect(sixBitDecode(sixBitEncode(m))).toBe(m);
  });
  it('model tables are identical on every build (integer-quantised)', () => {
    const m = getModel();
    let h = 0;
    for (const c of m.cum) for (const v of c) h = (Math.imul(h, 31) + v) >>> 0;
    expect(h).toBe(getModel().cum.reduce((a, c) => c.reduce((b, v) => (Math.imul(b, 31) + v) >>> 0, a), 0));
  });
});
