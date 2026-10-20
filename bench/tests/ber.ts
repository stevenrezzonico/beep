/**
 * Modem BER/PER mode — PLACEHOLDER. The parent modem work (modem/) fills `berModem` with an
 * adapter; the bench UI already renders its profiles, transmits `txSignal` and analyses
 * recordings with `analyze`, logging one result per run (profile, distance, SNR).
 *
 * Contract:
 *  - The payload is pseudo-random from `seed`, so the receiver regenerates it and compares bits
 *    without any side channel.
 *  - `txSignal` must be self-contained (its own preamble/marker), at amplitude ≤ 1; the bench
 *    applies the TX gain.
 *  - `analyze` must be deterministic for a given recording.
 */
export interface BerProfile {
  id: string;
  label: string;
  /** Raw/net bit rate for display, bits/s. */
  rawBps?: number;
  netBps?: number;
}

export interface BerRunOptions {
  packets: number;
  payloadBytes: number;
  seed: number;
}

export interface BerPacketResult {
  index: number;
  detected: boolean;
  crcOk: boolean;
  bitErrors: number;
  bits: number;
  snrDb?: number;
  timingOffsetSec?: number;
  freqOffsetHz?: number;
  correctedSymbols?: number;
}

export interface BerResult {
  test: 'ber';
  profile: string;
  fs: number;
  packetsSent: number;
  packetsDetected: number;
  packetsOk: number;
  bitErrors: number;
  bitsCompared: number;
  ber: number;
  per: number;
  meanSnrDb?: number;
  packets: BerPacketResult[];
}

export interface BerModem {
  profiles(): BerProfile[];
  /** Seconds of audio `txSignal` produces for these options (sizes the RX recording). */
  durationSec(profileId: string, o: BerRunOptions): number;
  txSignal(fs: number, profileId: string, o: BerRunOptions): Float32Array;
  analyze(rec: Float32Array, fs: number, profileId: string, o: BerRunOptions): BerResult;
}

export const BER_DEFAULTS: BerRunOptions = { packets: 10, payloadBytes: 16, seed: 1 };

/** TODO(modem): set to the modem adapter once modem/ exports a transmitter and receiver. */
export const berModem: BerModem | null = null;
