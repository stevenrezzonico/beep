import { encodeContent, decodeContent, type Content } from './content.ts';
import { writeSingle, writeFragment, writeControl, parseFrame, fragmentHeaderBits, FrameType, ContentType, ControlKind, type Frame } from './frame.ts';
import { encodeFragment, RlncDecoder } from './rlnc.ts';
import { crc32Bytes } from '../modem/fec/crc.ts';
import { packBits } from './bits.ts';

/**
 * Message layer: content → one or more PHY payloads, and the bounded reassembler.
 *
 * Fragmented messages carry an envelope: LEB128 length ‖ content bytes ‖ CRC-32, split into k
 * equal source fragments (zero-padded) plus repair fragments from the rateless code. The CRC-32
 * catches a reassembly that mixed fragments of two messages whose 7-bit ids collided.
 */

/** Largest PHY payload per profile, chosen so one packet stays ≲15 s on air (D-015). */
export const MAX_PACKET_BYTES: Record<string, number> = { 'long-range': 32, balanced: 64, fast: 192 };

export interface SendOptions {
  /** PHY payload size cap for the chosen profile (bytes). */
  maxPacket: number;
  /** Extra repair fragments as a fraction of k (broadcast default 0.25), at least `minRepair`. */
  repairRatio?: number;
  minRepair?: number;
  /** Ask receivers for an ACK/NEED reply (1:1 mode only). */
  ack?: boolean;
  /** Message id (sender-chosen counter). */
  id: number;
}

export interface Outgoing {
  payloads: Uint8Array[];
  fragmented: boolean;
  k: number;
  contentBits: number;
}

function leb128(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function readLeb128(b: Uint8Array): { value: number; size: number } | null {
  let v = 0, shift = 0;
  for (let i = 0; i < Math.min(b.length, 5); i++) {
    v |= (b[i] & 0x7f) << shift;
    if (!(b[i] & 0x80)) return { value: v >>> 0, size: i + 1 };
    shift += 7;
  }
  return null;
}

export function encodeMessage(c: Content, o: SendOptions): Outgoing {
  const enc = encodeContent(c);
  const single = writeSingle(enc.ctype, !!o.ack, o.id, enc.bits);
  if (single.length <= o.maxPacket) return { payloads: [single], fragmented: false, k: 1, contentBits: enc.bits.length };
  // envelope
  const content = packBits(enc.bits); // compact text tolerates trailing zero bits; byte types are whole bytes
  const env = new Uint8Array([...leb128(content.length), ...content, 0, 0, 0, 0]);
  new DataView(env.buffer).setUint32(env.length - 4, crc32Bytes(env.subarray(0, env.length - 4)));
  // fragment size F: the largest that keeps header + F bytes + ≥1 pad bit within maxPacket
  let k = 1, F = 0;
  for (;;) {
    F = Math.floor((o.maxPacket * 8 - 1 - fragmentHeaderBits(k, Math.ceil(k * 1.5) + 4)) / 8);
    const nk = Math.ceil(env.length / F);
    if (nk === k) break;
    k = nk;
  }
  const src: Uint8Array[] = [];
  for (let i = 0; i < k; i++) {
    const f = new Uint8Array(F);
    f.set(env.subarray(i * F, Math.min(env.length, (i + 1) * F)));
    src.push(f);
  }
  const r = Math.max(o.minRepair ?? 1, Math.ceil(k * (o.repairRatio ?? 0.25)));
  const payloads: Uint8Array[] = [];
  const key = msgKey(o.id, k);
  for (let i = 0; i < k + r; i++) payloads.push(writeFragment(enc.ctype, !!o.ack, o.id, k, i, encodeFragment(src, i, key)));
  return { payloads, fragmented: true, k, contentBits: enc.bits.length };
}

/** More repair fragments for an ongoing broadcast (carousel). */
export function repairPayloads(c: Content, o: SendOptions, from: number, count: number): Uint8Array[] {
  const full = encodeMessage(c, { ...o, repairRatio: 0, minRepair: 0 });
  if (!full.fragmented) return Array.from({ length: count }, () => full.payloads[0]);
  const frames = full.payloads.map((p) => parseFrame(p)) as Extract<Frame, { type: typeof FrameType.Fragment }>[];
  const src = frames.map((f) => f.data);
  const ctype = frames[0].ctype;
  const key = msgKey(o.id, full.k);
  const out: Uint8Array[] = [];
  for (let i = from; i < from + count; i++) out.push(writeFragment(ctype, !!o.ack, o.id, full.k, i, encodeFragment(src, i, key)));
  return out;
}

export function msgKey(id: number, k: number): number {
  return ((id & 127) << 16) | (k & 0xffff);
}

export type ReassemblyEvent =
  | { type: 'message'; id: number; content: Content; fragments: number; k: number; ackRequested: boolean }
  | { type: 'progress'; id: number; k: number; rank: number; received: number; duplicates: number; missingSources: number[] }
  | { type: 'control'; kind: number; id: number; n: number }
  | { type: 'duplicate'; id: number }
  | { type: 'error'; id?: number; reason: string };

export interface ReassemblerOptions {
  /** Concurrent partial messages kept (oldest evicted first). */
  maxMessages?: number;
  /** Cap on buffered fragment bytes across all partial messages. */
  maxBytes?: number;
  /** Partial messages idle longer than this are dropped, seconds. */
  timeoutSec?: number;
  /** Largest accepted k (protects memory and decode time). */
  maxK?: number;
}

interface Partial {
  key: string;
  id: number;
  k: number;
  size: number;
  ctype: ContentType;
  ack: boolean;
  dec: RlncDecoder;
  last: number;
}

/**
 * Bounded, order-independent reassembly. Duplicates are counted and dropped; any k independent
 * fragments complete a message; completed message keys are remembered so repeats of a finished
 * broadcast do not produce a second delivery.
 */
export class Reassembler {
  private parts = new Map<string, Partial>();
  private done = new Map<string, number>();
  private readonly o: Required<ReassemblerOptions>;

  constructor(o: ReassemblerOptions = {}) {
    this.o = { maxMessages: 8, maxBytes: 512 * 1024, timeoutSec: 900, maxK: 4096, ...o };
  }

  push(payload: Uint8Array, now: number): ReassemblyEvent[] {
    this.expire(now);
    const f = parseFrame(payload);
    if (!f) return [{ type: 'error', reason: 'malformed frame' }];
    if (f.type === FrameType.Extended) return [{ type: 'error', reason: `unsupported protocol version ${f.version}` }];
    if (f.type === FrameType.Control) return [{ type: 'control', kind: f.kind, id: f.id, n: f.n }];
    if (f.type === FrameType.Single) {
      const bits = f.content.bits.slice(f.content.pos, f.content.end);
      const key = `s${f.id}/${f.ctype}/${bits.join('')}`;
      if (this.seen(key, now)) return [{ type: 'duplicate', id: f.id }];
      try {
        return [{ type: 'message', id: f.id, content: decodeContent(f.ctype, bits), fragments: 1, k: 1, ackRequested: f.ack }];
      } catch (e) {
        return [{ type: 'error', id: f.id, reason: (e as Error).message }];
      }
    }
    // fragment
    if (f.k > this.o.maxK || f.data.length === 0) return [{ type: 'error', id: f.id, reason: 'fragment parameters out of range' }];
    const key = `f${f.id}/${f.k}/${f.data.length}/${f.ctype}`;
    if (this.done.has(key)) {
      this.done.set(key, now);
      return [{ type: 'duplicate', id: f.id }];
    }
    let p = this.parts.get(key);
    if (!p) {
      p = { key, id: f.id, k: f.k, size: f.data.length, ctype: f.ctype, ack: f.ack, dec: new RlncDecoder(f.k, f.data.length, msgKey(f.id, f.k)), last: now };
      this.parts.set(key, p);
      this.enforceBounds(key);
    }
    p.last = now;
    p.dec.add(f.index, f.data);
    const ev: ReassemblyEvent[] = [{ type: 'progress', id: f.id, k: f.k, rank: p.dec.rank, received: p.dec.received, duplicates: p.dec.duplicates, missingSources: p.dec.missingSources() }];
    if (!p.dec.complete) return ev;
    this.parts.delete(key);
    const src = p.dec.result()!;
    const env = new Uint8Array(p.k * p.size);
    src.forEach((s, i) => env.set(s, i * p.size));
    const len = readLeb128(env);
    if (!len || len.size + len.value + 4 > env.length) {
      ev.push({ type: 'error', id: f.id, reason: 'bad envelope length (fragments from different messages?)' });
      return ev;
    }
    const end = len.size + len.value;
    const crc = new DataView(env.buffer, env.byteOffset).getUint32(end);
    if (crc !== crc32Bytes(env.subarray(0, end))) {
      ev.push({ type: 'error', id: f.id, reason: 'message CRC-32 mismatch (id collision?) — discarded' });
      return ev;
    }
    this.done.set(key, now);
    const bits: number[] = [];
    for (const v of env.subarray(len.size, end)) for (let i = 7; i >= 0; i--) bits.push((v >> i) & 1);
    try {
      ev.push({ type: 'message', id: f.id, content: decodeContent(p.ctype, bits), fragments: p.dec.received, k: p.k, ackRequested: p.ack });
    } catch (e) {
      ev.push({ type: 'error', id: f.id, reason: (e as Error).message });
    }
    return ev;
  }

  /** Partial-message status for UI. */
  status(): { id: number; k: number; rank: number; received: number }[] {
    return [...this.parts.values()].map((p) => ({ id: p.id, k: p.k, rank: p.dec.rank, received: p.dec.received }));
  }

  /** Reply a sender asked for (1:1 mode): ACK if complete, else NEED n. */
  reply(id: number): Uint8Array | null {
    const p = [...this.parts.values()].find((x) => x.id === id);
    if (p) return writeControl(ControlKind.Need, id, p.k - p.dec.rank);
    for (const k of this.done.keys()) if (k.startsWith(`f${id}/`)) return writeControl(ControlKind.Ack, id);
    return null;
  }

  private seen(key: string, now: number): boolean {
    const t = this.done.get(key);
    this.done.set(key, now);
    return t !== undefined && now - t < this.o.timeoutSec;
  }

  private expire(now: number): void {
    for (const [k, p] of this.parts) if (now - p.last > this.o.timeoutSec) this.parts.delete(k);
    for (const [k, t] of this.done) if (now - t > this.o.timeoutSec) this.done.delete(k);
    if (this.done.size > 256) {
      const old = [...this.done.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.done.size - 256);
      for (const [k] of old) this.done.delete(k);
    }
  }

  private enforceBounds(keep: string): void {
    const bytes = () => [...this.parts.values()].reduce((a, p) => a + p.k * p.size * 2, 0);
    while (this.parts.size > this.o.maxMessages || bytes() > this.o.maxBytes) {
      const oldest = [...this.parts.values()].filter((p) => p.key !== keep).sort((a, b) => a.last - b.last)[0];
      if (!oldest) break;
      this.parts.delete(oldest.key);
    }
  }
}
