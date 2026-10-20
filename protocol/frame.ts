import { BitWriter, BitReader } from './bits.ts';

/**
 * Protocol frame = the PHY payload (1…256 bytes; the PHY header already carries profile and
 * length, and the PHY CRC-16 covers everything here). Bit-packed, MSB first.
 *
 *   Single     00 ctype:2 ack:1 id:3                         | content bits | 1-0 pad     (8 bits)
 *   Fragment   01 ctype:2 ack:1 id:7 EG(k−1) EG(index)       | fragment bytes | 1-0 pad  (≈14–30 bits)
 *   Control    10 kind:2 id:7 [EG(n)]                        | 1-0 pad
 *   Extended   11 EG(version−2) …                            (reserved; v1 receivers report and drop)
 *
 * Field rationale is in docs/PROTOCOL.md. Content types: 0 compact text, 1 UTF-8 text,
 * 2 raw bytes, 3 typed (EG(subtype) follows; 0 = file: name as compact text, then bytes).
 */
export const FrameType = { Single: 0, Fragment: 1, Control: 2, Extended: 3 } as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const ContentType = { CompactText: 0, Utf8Text: 1, Bytes: 2, Typed: 3 } as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/** Ack: message `id` fully received. Need: message `id` needs `n` more fragments (any — the code is rateless). */
export const ControlKind = { Ack: 0, Need: 1 } as const;
export type ControlKind = (typeof ControlKind)[keyof typeof ControlKind];

export type Frame =
  | { type: typeof FrameType.Single; ctype: ContentType; ack: boolean; id: number; content: BitReader }
  | { type: typeof FrameType.Fragment; ctype: ContentType; ack: boolean; id: number; k: number; index: number; data: Uint8Array }
  | { type: typeof FrameType.Control; kind: number; id: number; n: number }
  | { type: typeof FrameType.Extended; version: number };

export function writeSingle(ctype: ContentType, ack: boolean, id: number, content: number[]): Uint8Array {
  const w = new BitWriter().write(FrameType.Single, 2).write(ctype, 2).bit(ack).write(id & 7, 3);
  for (const b of content) w.bit(b);
  return w.toBytesPadded();
}

export function fragmentHeaderBits(k: number, index: number): number {
  return new BitWriter().write(0, 12).expGolomb(k - 1).expGolomb(index).length;
}

export function writeFragment(ctype: ContentType, ack: boolean, id: number, k: number, index: number, data: Uint8Array): Uint8Array {
  const w = new BitWriter().write(FrameType.Fragment, 2).write(ctype, 2).bit(ack).write(id & 127, 7).expGolomb(k - 1).expGolomb(index);
  w.bytes(data);
  return w.toBytesPadded();
}

export function writeControl(kind: ControlKind, id: number, n = 0): Uint8Array {
  const w = new BitWriter().write(FrameType.Control, 2).write(kind, 2).write(id & 127, 7);
  if (kind === ControlKind.Need) w.expGolomb(n);
  return w.toBytesPadded();
}

export function parseFrame(payload: Uint8Array): Frame | null {
  const r = BitReader.fromPadded(payload);
  if (!r) return null;
  try {
    const t = r.read(2);
    if (t === FrameType.Single) {
      const ctype = r.read(2) as ContentType;
      const ack = r.bit() === 1;
      const id = r.read(3);
      return { type: FrameType.Single, ctype, ack, id, content: r };
    }
    if (t === FrameType.Fragment) {
      const ctype = r.read(2) as ContentType;
      const ack = r.bit() === 1;
      const id = r.read(7);
      const k = r.expGolomb() + 1;
      const index = r.expGolomb();
      if (r.remaining % 8 !== 0) return null;
      return { type: FrameType.Fragment, ctype, ack, id, k, index, data: r.restBytes() };
    }
    if (t === FrameType.Control) {
      const kind = r.read(2);
      const id = r.read(7);
      const n = kind === ControlKind.Need ? r.expGolomb() : 0;
      return { type: FrameType.Control, kind, id, n };
    }
    return { type: FrameType.Extended, version: r.expGolomb() + 2 };
  } catch {
    return null;
  }
}
