import { compactEncode, compactDecode } from './text/codecs.ts';
import { BitWriter, BitReader, unpackBits } from './bits.ts';
import { ContentType } from './frame.ts';

/** Application content and its compact bit encodings (sender picks the smallest). */
export type Content = { kind: 'text'; text: string } | { kind: 'bytes'; data: Uint8Array } | { kind: 'file'; name: string; data: Uint8Array };

export interface Encoded {
  ctype: ContentType;
  bits: number[];
}

/** Choose the cheapest representation. */
export function encodeContent(c: Content): Encoded {
  if (c.kind === 'text') {
    const compact = compactEncode(c.text);
    const utf8 = Array.from(new TextEncoder().encode(c.text)).flatMap(byteBits);
    return compact.length <= utf8.length ? { ctype: ContentType.CompactText, bits: compact } : { ctype: ContentType.Utf8Text, bits: utf8 };
  }
  if (c.kind === 'bytes') return { ctype: ContentType.Bytes, bits: Array.from(c.data).flatMap(byteBits) };
  // typed: EG(subtype=0 file) | name (compact text, self-terminating) | bytes
  const w = new BitWriter().expGolomb(0);
  for (const b of compactEncode(c.name)) w.bit(b);
  return { ctype: ContentType.Typed, bits: [...w.toBits(), ...Array.from(c.data).flatMap(byteBits)] };
}

function byteBits(v: number): number[] {
  return [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (v >> i) & 1);
}

function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length * 8; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/** Decode content bits (exact length known for byte-based types; compact text is self-terminating). */
export function decodeContent(ctype: ContentType, bits: number[]): Content {
  if (ctype === ContentType.CompactText) return { kind: 'text', text: compactDecode(bits) };
  if (ctype === ContentType.Utf8Text) return { kind: 'text', text: new TextDecoder('utf-8', { fatal: false }).decode(bitsToBytes(bits)) };
  if (ctype === ContentType.Bytes) return { kind: 'bytes', data: bitsToBytes(bits) };
  const r = new BitReader(bits);
  const sub = r.expGolomb();
  if (sub !== 0) throw new Error(`unsupported typed content ${sub}`);
  // decode the name, then locate where it ended by re-encoding (the arithmetic code is self-delimiting)
  const rest = bits.slice(r.pos);
  const name = compactDecode(rest);
  const used = compactEncode(name).length;
  return { kind: 'file', name, data: bitsToBytes(rest.slice(used)) };
}

export { unpackBits };
