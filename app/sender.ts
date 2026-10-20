import { modulatePacket, airTime } from '../modem/tx.ts';
import { DEFAULT_CONFIG, describe, type Profile } from '../modem/profiles.ts';
import { encodeMessage, repairPayloads, MAX_PACKET_BYTES, type SendOptions } from '../protocol/message.ts';
import type { Content } from '../protocol/content.ts';

/**
 * Sending: content → protocol payloads → packets scheduled back to back on the AudioContext.
 * Packets are rendered one at a time just before they are needed, so a "keep repeating"
 * broadcast can run indefinitely without holding minutes of audio in memory.
 */

/** Silence between packets. The receiver needs none; a short gap keeps packets visibly apart. */
export const PACKET_GAP = 0.15;
/** How far ahead of the playhead the next packet is scheduled, seconds. */
const SCHEDULE_AHEAD = 1.5;

export interface SendPlan {
  content: Content;
  profile: Profile;
  options: SendOptions;
  payloads: Uint8Array[];
  fragmented: boolean;
  k: number;
  /** Air time of the planned packets including gaps, seconds. */
  airSec: number;
  /** Net throughput of the profile, bits/s. */
  netBps: number;
  contentBits: number;
}

export function planSend(content: Content, profile: Profile, id: number, repairRatio: number): SendPlan {
  const options: SendOptions = { maxPacket: MAX_PACKET_BYTES[profile.name], id, repairRatio, minRepair: repairRatio > 0 ? 1 : 0 };
  const out = encodeMessage(content, options);
  const airSec = out.payloads.reduce((a, p) => a + airTime(p.length, profile) + PACKET_GAP, 0);
  const netBps = describe(DEFAULT_CONFIG).profiles.find((p) => p.name === profile.name)!.netBps;
  return { content, profile, options, payloads: out.payloads, fragmented: out.fragmented, k: out.k, airSec, netBps, contentBits: out.contentBits };
}

export interface ScheduledPacket {
  index: number;
  start: number;
  end: number;
  bytes: number;
  /** A repair fragment (fragmented message) or a repeat (single-packet message). */
  repair: boolean;
}

export interface TransmissionOptions {
  /** Peak level, dBFS (the modem renders at peak 1). */
  levelDb: number;
  /** After the planned packets, keep sending fresh repair fragments until stopped. */
  carousel: boolean;
}

export class Transmission {
  readonly ctx: AudioContext;
  readonly plan: SendPlan;
  readonly analyser: AnalyserNode;
  readonly scheduled: ScheduledPacket[] = [];
  private readonly gain: GainNode;
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly o: TransmissionOptions;
  private stopped = false;
  private next = 0;

  constructor(ctx: AudioContext, plan: SendPlan, o: TransmissionOptions) {
    this.ctx = ctx;
    this.plan = plan;
    this.o = o;
    this.gain = ctx.createGain();
    this.gain.gain.value = Math.pow(10, o.levelDb / 20);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.gain.connect(ctx.destination);
    this.gain.connect(this.analyser);
  }

  private payload(i: number): Uint8Array {
    if (i < this.plan.payloads.length) return this.plan.payloads[i];
    return repairPayloads(this.plan.content, this.plan.options, i, 1)[0];
  }

  private schedule(i: number, at: number): number {
    const fs = this.ctx.sampleRate;
    const p = this.payload(i);
    const w = modulatePacket(p, this.plan.profile, fs, DEFAULT_CONFIG, { level: 1, padSec: 0.02 });
    const buf = this.ctx.createBuffer(1, w.length, fs);
    buf.getChannelData(0).set(w);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(at);
    this.sources.push(src);
    src.onended = () => {
      const k = this.sources.indexOf(src);
      if (k >= 0) this.sources.splice(k, 1);
    };
    const end = at + w.length / fs;
    this.scheduled.push({ index: i, start: at, end, bytes: p.length, repair: this.plan.fragmented ? i >= this.plan.k : i >= 1 });
    return end;
  }

  /** Runs until all planned packets have played (or forever in carousel mode) or stop(). */
  async run(): Promise<void> {
    let t = this.ctx.currentTime + 0.15;
    for (let i = 0; !this.stopped; i++) {
      if (!this.o.carousel && i >= this.plan.payloads.length) break;
      // keep at most SCHEDULE_AHEAD seconds queued beyond the playhead
      while (!this.stopped && t - this.ctx.currentTime > SCHEDULE_AHEAD) await new Promise((r) => setTimeout(r, 100));
      if (this.stopped) break;
      t = Math.max(t, this.ctx.currentTime + 0.05);
      t = this.schedule(i, t) + PACKET_GAP;
      this.next = i + 1;
    }
    while (!this.stopped && this.ctx.currentTime < t) await new Promise((r) => setTimeout(r, 100));
    this.teardown();
  }

  /** Number of packets handed to the audio clock so far. */
  get sent(): number {
    return this.next;
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  private teardown(): void {
    for (const s of this.sources.splice(0)) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    try {
      this.gain.disconnect();
    } catch {
      /* already */
    }
  }
}
