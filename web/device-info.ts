import { currentContext, getAudioSessionType } from './audio.ts';

/** A snapshot of everything about the device that can change the acoustic result. */
export interface DeviceRecord {
  label: string;
  timestamp: string;
  userAgent: string;
  platform: string;
  /** iOS version parsed from the UA when present (WebKit on iOS reports "OS 17_4"). */
  iosVersion: string | null;
  sampleRate: number | null;
  baseLatency: number | null;
  outputLatency: number | null;
  maxChannelCount: number | null;
  audioSessionType: string | null;
  hardwareConcurrency: number | null;
  screen: string;
  micSettings?: MediaTrackSettings;
  micVerdict?: unknown;
}

export function collectDeviceInfo(label = '', micSettings?: MediaTrackSettings): DeviceRecord {
  const c = currentContext();
  const ua = navigator.userAgent;
  const ios = /OS (\d+[_\d]*) like Mac OS X/.exec(ua);
  return {
    label,
    timestamp: new Date().toISOString(),
    userAgent: ua,
    platform: (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '',
    iosVersion: ios ? ios[1].replace(/_/g, '.') : null,
    sampleRate: c?.sampleRate ?? null,
    baseLatency: c?.baseLatency ?? null,
    outputLatency: (c as AudioContext & { outputLatency?: number })?.outputLatency ?? null,
    maxChannelCount: c?.destination.maxChannelCount ?? null,
    audioSessionType: getAudioSessionType() ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    micSettings,
  };
}
