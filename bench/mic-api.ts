import { ensureContext, resetContext, setAudioSessionType, getAudioSessionType, RAW_CONSTRAINTS, log } from '../web/audio.ts';

/**
 * API layer of the mic-processing check: what the browser *claims* about echo cancellation, noise
 * suppression and AGC, before and after asking to turn them off. The empirical tests decide what
 * is actually happening; comparing the two is the point.
 */
export interface MicApiVariant {
  audioSession: 'unset' | 'auto' | 'play-and-record' | 'playback';
  order: 'context-first' | 'mic-first';
  explicitVideoFalse: boolean;
}

const KEYS = ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'channelCount', 'sampleRate', 'latency', 'deviceId'] as const;

export interface MicApiReport {
  test: 'mic-api';
  variant: MicApiVariant;
  timestamp: string;
  userAgent: string;
  supportedConstraints: Record<string, boolean>;
  capabilities: Record<string, unknown> | 'unsupported';
  settings: Record<string, unknown>;
  applyConstraints: { threw: string | null; settingsAfter: Record<string, unknown> | null; changed: string[] };
  audioSessionType: string | null;
  contextSampleRate: number | null;
  trackLabel: string;
  error: string | null;
}

function pick(o: object | undefined): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (!o) return r;
  for (const k of KEYS) if (k in o) r[k] = (o as Record<string, unknown>)[k];
  return r;
}

export async function probeMicApi(variant: MicApiVariant): Promise<MicApiReport> {
  const rep: MicApiReport = {
    test: 'mic-api',
    variant,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    supportedConstraints: {},
    capabilities: 'unsupported',
    settings: {},
    applyConstraints: { threw: null, settingsAfter: null, changed: [] },
    audioSessionType: null,
    contextSampleRate: null,
    trackLabel: '',
    error: null,
  };
  const sc = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>;
  for (const k of KEYS) rep.supportedConstraints[k] = !!sc[k];
  let stream: MediaStream | null = null;
  try {
    if (variant.audioSession !== 'unset') setAudioSessionType(variant.audioSession);
    const req: MediaStreamConstraints = variant.explicitVideoFalse ? { audio: RAW_CONSTRAINTS, video: false } : { audio: RAW_CONSTRAINTS };
    if (variant.order === 'mic-first') {
      // a context may already exist from earlier taps; close it so the mic really comes first
      await resetContext();
      stream = await navigator.mediaDevices.getUserMedia(req);
      rep.contextSampleRate = (await ensureContext()).sampleRate;
    } else {
      rep.contextSampleRate = (await ensureContext()).sampleRate;
      stream = await navigator.mediaDevices.getUserMedia(req);
    }
    const track = stream.getAudioTracks()[0];
    rep.trackLabel = track.label;
    rep.capabilities = typeof track.getCapabilities === 'function' ? pick(track.getCapabilities()) : 'unsupported';
    rep.settings = pick(track.getSettings());
    try {
      await track.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    } catch (e) {
      rep.applyConstraints.threw = `${(e as Error).name}: ${(e as Error).message}`;
    }
    const after = pick(track.getSettings());
    rep.applyConstraints.settingsAfter = after;
    rep.applyConstraints.changed = Object.keys(after).filter((k) => after[k] !== rep.settings[k]);
    rep.audioSessionType = getAudioSessionType() ?? null;
  } catch (e) {
    rep.error = `${(e as Error).name}: ${(e as Error).message}`;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
  log(`mic API probe ${JSON.stringify(variant)} → settings ${JSON.stringify(rep.settings)}${rep.error ? ' error ' + rep.error : ''}`);
  return rep;
}
