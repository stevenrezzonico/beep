/**
 * Shared browser audio layer for the bench and the app.
 *
 * Platform rules this module encodes:
 *  - One AudioContext for the page, created and resumed inside a user gesture (iOS refuses
 *    otherwise and may silently keep it 'suspended').
 *  - Mic requested with all voice processing off — but callers must not trust that it was
 *    honoured; the bench measures it.
 *  - Half-duplex: a held mic track switches iOS to play-and-record and routes output to the
 *    earpiece, so callers release the mic before transmitting.
 *  - The context can be suspended/'interrupted' by backgrounding, calls or the silent switch;
 *    listeners are told so the UI can ask for a tap to resume.
 */

import workletSource from './capture-worklet.js?raw';

export type LogFn = (msg: string) => void;
const logListeners = new Set<LogFn>();
export const audioLog: string[] = [];

export function log(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  audioLog.push(line);
  if (audioLog.length > 500) audioLog.shift();
  for (const l of logListeners) l(line);
}

export function onLog(fn: LogFn): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

// ---------------------------------------------------------------- context

let ctx: AudioContext | null = null;
let workletLoaded: Promise<void> | null = null;
const stateListeners = new Set<(s: string) => void>();

export function onContextState(fn: (s: string) => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

export function currentContext(): AudioContext | null {
  return ctx;
}

/** Create (if needed) and resume the shared context. Call from a click/touch handler. */
export async function ensureContext(): Promise<AudioContext> {
  if (!ctx) {
    const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // 'interactive' asks for the smallest buffers; sampleRate is deliberately left to the device
    ctx = new AC({ latencyHint: 'interactive' });
    log(`AudioContext created: sampleRate=${ctx.sampleRate} baseLatency=${ctx.baseLatency ?? 'n/a'}`);
    const c = ctx;
    c.onstatechange = () => {
      log(`AudioContext state → ${c.state}`);
      for (const l of stateListeners) l(c.state);
    };
    workletLoaded = null;
  }
  if (ctx.state !== 'running') {
    await ctx.resume();
    log(`AudioContext resumed: state=${ctx.state}`);
  }
  return ctx;
}

/** Close and forget the context (used to test mic-before-context acquisition order). */
export async function resetContext(): Promise<void> {
  if (!ctx) return;
  const c = ctx;
  ctx = null;
  workletLoaded = null;
  try {
    await c.close();
  } catch {
    /* already closed */
  }
  log('AudioContext closed');
}

async function ensureWorklet(c: AudioContext): Promise<void> {
  if (!c.audioWorklet) throw new Error('AudioWorklet not supported by this browser (needs iOS ≥ 14.5, Chrome ≥ 66, Firefox ≥ 76)');
  // Loaded from a Blob URL built from the inlined source: the bundler would otherwise inline the
  // small file as a data: URL, which not every WebKit version accepts for addModule.
  if (!workletLoaded) {
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    workletLoaded = c.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  }
  await workletLoaded;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    log(`visibility → ${document.visibilityState}; context=${ctx?.state ?? 'none'}`);
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') {
      // Chrome allows resuming here; iOS usually needs a tap, which the UI will ask for.
      ctx.resume().catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------- iOS audio session

type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
interface AudioSessionLike {
  type: AudioSessionType;
  state?: string;
}

function session(): AudioSessionLike | undefined {
  return (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
}

export function audioSessionSupported(): boolean {
  return !!session();
}

export function getAudioSessionType(): string | undefined {
  return session()?.type;
}

/** Set navigator.audioSession.type where available (Safari 16.4+); logs and returns the result. */
export function setAudioSessionType(t: AudioSessionType | 'unset'): string | undefined {
  const s = session();
  if (!s) {
    log('navigator.audioSession not available');
    return undefined;
  }
  try {
    s.type = t === 'unset' ? 'auto' : t;
  } catch (e) {
    log(`audioSession.type=${t} threw: ${(e as Error).message}`);
  }
  log(`audioSession.type requested ${t}, now ${s.type} (state ${s.state ?? 'n/a'})`);
  return s.type;
}

// ---------------------------------------------------------------- mic

export const RAW_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export interface MicOptions {
  constraints?: MediaTrackConstraints;
  /** Acquire getUserMedia before creating the AudioContext (WebKit routing experiments). */
  order?: 'context-first' | 'mic-first';
  /** Pass `video: false` explicitly in the getUserMedia call. */
  explicitVideoFalse?: boolean;
  /** Worklet block size in frames. */
  blockSize?: number;
}

export interface MicChunk {
  samples: Float32Array;
  /** Index of the first frame of this chunk since capture start. */
  frame: number;
}

/** A held microphone track feeding a capture worklet. */
export class Mic {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly ctx: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  private readonly sink: GainNode;
  private readonly listeners = new Set<(c: MicChunk) => void>();
  private released = false;
  /** Frames delivered so far, and how many went missing (gaps between worklet blocks). */
  frames = 0;
  dropped = 0;

  private constructor(ctx: AudioContext, stream: MediaStream, blockSize: number) {
    this.ctx = ctx;
    this.stream = stream;
    this.track = stream.getAudioTracks()[0];
    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, 'beep-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { blockSize },
    });
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; frame: number }>) => {
      const { samples, frame } = e.data;
      if (frame > this.frames) this.dropped += frame - this.frames;
      this.frames = frame + samples.length;
      for (const l of this.listeners) l({ samples, frame });
    };
    this.track.addEventListener('ended', () => log('mic track ended (revoked or device change)'));
    this.track.addEventListener('mute', () => log('mic track muted by the system'));
    this.track.addEventListener('unmute', () => log('mic track unmuted'));
  }

  /** Acquire the mic. Must run in a user gesture on iOS (it also creates the context). */
  static async acquire(o: MicOptions = {}): Promise<Mic> {
    const constraints = { ...RAW_CONSTRAINTS, ...(o.constraints ?? {}) };
    const req: MediaStreamConstraints = o.explicitVideoFalse ? { audio: constraints, video: false } : { audio: constraints };
    let stream: MediaStream;
    let c: AudioContext;
    if (o.order === 'mic-first') {
      stream = await navigator.mediaDevices.getUserMedia(req);
      c = await ensureContext();
    } else {
      c = await ensureContext();
      stream = await navigator.mediaDevices.getUserMedia(req);
    }
    await ensureWorklet(c);
    const mic = new Mic(c, stream, o.blockSize ?? 2048);
    log(`mic acquired (${o.order ?? 'context-first'}${o.explicitVideoFalse ? ', video:false' : ''}): ${JSON.stringify(mic.settings())}`);
    return mic;
  }

  settings(): MediaTrackSettings {
    return this.track.getSettings();
  }

  get active(): boolean {
    return !this.released && this.track.readyState === 'live';
  }

  onData(fn: (c: MicChunk) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Record `durSec` seconds starting with the next delivered block. Progress is reported in
   * [0,1]. The AbortSignal stops early and resolves with what was captured.
   */
  record(durSec: number, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<Float32Array> {
    const total = Math.round(durSec * this.ctx.sampleRate);
    const out = new Float32Array(total);
    let n = 0;
    return new Promise((resolve) => {
      const finish = () => {
        off();
        resolve(n < total ? out.subarray(0, n) : out);
      };
      const off = this.onData(({ samples }) => {
        const k = Math.min(samples.length, total - n);
        out.set(samples.subarray(0, k), n);
        n += k;
        onProgress?.(n / total);
        if (n >= total) finish();
      });
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** Stop the tracks and tear down the graph (half-duplex: before every transmission). */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.node.port.postMessage('stop');
    this.listeners.clear();
    try {
      this.source.disconnect();
      this.node.disconnect();
      this.sink.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const t of this.stream.getTracks()) t.stop();
    log('mic released');
  }
}

// ---------------------------------------------------------------- playback

export interface PlayOptions {
  /** Gain applied to the buffer, dB (signals are generated with peak ≤ 1). */
  gainDb?: number;
  /** Seconds from now to start; a small lead lets the graph start sample-accurately. */
  lead?: number;
}

export interface Playback {
  /** AudioContext time at which the first sample plays. */
  startTime: number;
  duration: number;
  ended: Promise<void>;
  stop(): void;
}

/** Play a mono buffer at the context rate via AudioBufferSourceNode (sample-accurate start). */
export async function play(x: Float32Array, o: PlayOptions = {}): Promise<Playback> {
  const c = await ensureContext();
  const g = Math.pow(10, (o.gainDb ?? -6) / 20);
  const buf = c.createBuffer(1, x.length, c.sampleRate);
  const ch = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    ch[i] = x[i] * g;
    peak = Math.max(peak, Math.abs(ch[i]));
  }
  if (peak > 1) log(`warning: playback peak ${peak.toFixed(2)} > 1 will clip — lower the TX level`);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  const startTime = c.currentTime + (o.lead ?? 0.1);
  const ended = new Promise<void>((resolve) => {
    src.onended = () => resolve();
  });
  src.start(startTime);
  log(`play ${(x.length / c.sampleRate).toFixed(2)} s at ${(o.gainDb ?? -6).toFixed(1)} dB (peak ${(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1)} dBFS)`);
  return {
    startTime,
    duration: x.length / c.sampleRate,
    ended,
    stop: () => {
      try {
        src.stop();
      } catch {
        /* not started */
      }
    },
  };
}
