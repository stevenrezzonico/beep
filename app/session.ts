import { Receiver, type RxEvent, type RxState, type PacketDiag } from '../modem/rx.ts';
import { DEFAULT_CONFIG, profileByName, type ModemConfig } from '../modem/profiles.ts';
import { payloadSymbolCount } from '../modem/frame.ts';
import { bandInfo } from '../modem/band.ts';
import { Reassembler } from '../protocol/message.ts';
import type { Content } from '../protocol/content.ts';

/**
 * Receive session: modem Receiver + protocol Reassembler, plus the bookkeeping the UI shows.
 * DOM-free so it runs (and is tested) in Node; the page feeds it microphone chunks.
 * Only CRC-checked packets reach the reassembler, so nothing corrupt is ever displayed.
 */

export interface PacketLog {
  /** Stream time (s) of the packet's sync. */
  time: number;
  ok: boolean;
  diag: PacketDiag;
  /** What the packet carried, once parsed by the protocol layer. */
  note: string;
}

export interface ReceivedMessage {
  id: number;
  content: Content;
  fragments: number;
  k: number;
  at: Date;
}

export interface PartialMessage {
  id: number;
  k: number;
  rank: number;
  received: number;
  duplicates: number;
}

export interface SessionCounters {
  detections: number;
  syncFails: number;
  headerFails: number;
  packetsOk: number;
  packetsFailed: number;
  duplicates: number;
}

export class RxSession {
  readonly fs: number;
  readonly cfg: ModemConfig;
  readonly rx: Receiver;
  readonly reasm = new Reassembler();
  readonly packets: PacketLog[] = [];
  readonly messages: ReceivedMessage[] = [];
  readonly partials = new Map<number, PartialMessage>();
  readonly errors: { time: number; reason: string }[] = [];
  readonly counters: SessionCounters = { detections: 0, syncFails: 0, headerFails: 0, packetsOk: 0, packetsFailed: 0, duplicates: 0 };
  /** Samples consumed: the receiver's clock. */
  private n = 0;
  /** Payload in flight: [start, end] on the stream clock, for the progress bar. */
  private payload: { profile: string; start: number; end: number; length: number } | null = null;
  /** Called after every chunk that produced events. */
  onEvent: ((e: RxEvent) => void) | null = null;

  constructor(fs: number, cfg: ModemConfig = DEFAULT_CONFIG) {
    this.fs = fs;
    this.cfg = cfg;
    this.rx = new Receiver(fs, cfg);
  }

  get time(): number {
    return this.n / this.fs;
  }

  get state(): RxState {
    return this.rx.state;
  }

  /** Detection statistic relative to the threshold, dB (≥ 0 means "preamble-like energy"). */
  get signalDb(): number {
    return this.rx.lastRatioDb;
  }

  /** Progress of the packet being received, if in the payload. */
  get progress(): { profile: string; fraction: number; length: number } | null {
    if (this.state !== 'payload' || !this.payload) return null;
    const p = this.payload;
    return { profile: p.profile, length: p.length, fraction: Math.min(1, Math.max(0, (this.time - p.start) / (p.end - p.start))) };
  }

  push(samples: Float32Array): void {
    this.n += samples.length;
    for (const e of this.rx.push(samples)) this.handle(e);
  }

  private handle(e: RxEvent): void {
    const now = this.time;
    switch (e.type) {
      case 'detect':
        this.counters.detections++;
        break;
      case 'sync-fail':
        this.counters.syncFails++;
        break;
      case 'header-fail':
        this.counters.headerFails++;
        break;
      case 'header': {
        const p = profileByName(this.cfg, e.profile);
        const b = bandInfo(this.cfg.band);
        const tsPre = (1 << this.cfg.sfPre) / b.bw;
        const start = e.time + (this.cfg.nDown + this.cfg.nHeader) * tsPre;
        const dur = (payloadSymbolCount(e.header.length, p.sf, p.rate) * (1 << p.sf)) / b.bw;
        this.payload = { profile: p.name, start, end: start + dur, length: e.header.length };
        break;
      }
      case 'packet':
        this.payload = null;
        if (!e.ok) {
          this.counters.packetsFailed++;
          this.packets.unshift({ time: e.diag.syncTime, ok: false, diag: e.diag, note: 'CRC failed — discarded' });
          break;
        }
        this.counters.packetsOk++;
        this.packets.unshift({ time: e.diag.syncTime, ok: true, diag: e.diag, note: this.deliver(e.data, now) });
        break;
    }
    if (this.packets.length > 200) this.packets.length = 200;
    this.onEvent?.(e);
  }

  /** Hand a CRC-checked payload to the protocol layer; returns a short description for the log. */
  private deliver(data: Uint8Array, now: number): string {
    let note = '';
    for (const r of this.reasm.push(data, now)) {
      switch (r.type) {
        case 'message':
          this.partials.delete(r.id);
          this.messages.unshift({ id: r.id, content: r.content, fragments: r.fragments, k: r.k, at: new Date() });
          note = r.k > 1 ? `message #${r.id} complete (${r.fragments} fragments for k=${r.k})` : `message #${r.id}`;
          break;
        case 'progress':
          this.partials.set(r.id, { id: r.id, k: r.k, rank: r.rank, received: r.received, duplicates: r.duplicates });
          note = `fragment of #${r.id}: ${r.rank}/${r.k}`;
          break;
        case 'duplicate':
          this.counters.duplicates++;
          note = `repeat of #${r.id} (already received)`;
          break;
        case 'control':
          note = `control ${r.kind} for #${r.id}`;
          break;
        case 'error':
          this.errors.unshift({ time: now, reason: r.reason });
          note = `protocol error: ${r.reason}`;
          break;
      }
    }
    return note;
  }
}
