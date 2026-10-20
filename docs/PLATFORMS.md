# Platforms: setup, behaviour and known limitations

The acceptance test is real devices, not the simulator. This page has two kinds of content:

- **Expected behaviour**: what the browser documentation and prior experience say. Each item is
  something the bench checks, and nothing here is a measured result yet.
- **Measured results**: filled in from bench exports (`beep-bench-*.json`). Each row cites the
  export file.

> **Measured results: none yet.** No real-device bench runs have been logged. Every distance and
> reliability figure elsewhere in the docs is simulated. To add a device, run the bench's
> *Mic-processing check*, *Frequency response* and *Echo* tests and commit the export under
> `docs/measurements/`. Then add a row below.

## Quick setup

| Platform | Steps |
|---|---|
| Desktop Chrome / Edge / Firefox | Open the page (localhost or HTTPS) and allow the microphone. Use the built-in speakers or an external speaker. Bluetooth speakers usually low-pass or compress the band, so avoid them. |
| Desktop Safari | Same as above. Safari only exposes `navigator.audioSession` on recent versions; the bench logs what it finds. |
| Android Chrome | HTTPS required. Turn media volume up. Disable "Adaptive sound", "Dolby Atmos" and similar effects, which can low-pass or compress above 16 kHz. Keep the screen on during a transfer. |
| iOS Safari | HTTPS required. Tap once to enable audio (the `AudioContext` must start in a gesture). Turn the volume up. The app sets `navigator.audioSession.type = 'playback'` for sending, so it plays even with the silent switch on where supported. On older iOS, turn the silent switch **off**. Keep the page in the foreground. |

## Architecture choices driven by platforms

- **Half-duplex.** iOS switches the audio session to play-and-record while a mic track is live,
  and routes output to the quiet earpiece. The app and bench therefore **stop all mic tracks
  before transmitting** and re-acquire the mic to listen. Transfers are one-directional anyway
  (broadcast-first), so this costs nothing. An ACK/NEED back-channel exists in the protocol for
  1:1 use. It is only switched on where the bench shows that turning the link around works on
  both devices.
- **No reliance on raw mic access.** The receiver works even if echo cancellation, noise
  suppression or AGC stay on:
  - detection uses within-FFT peak-to-mean ratios, not absolute levels;
  - each symbol is normalised by its own noise estimate (the digital AGC);
  - all thresholds come from false-alarm probabilities.

  What processing *does* cost is in-band SNR. A voice path low-passed below 17 kHz makes the
  band unusable. The mic check detects this and says so.
- **Sample-rate agnostic.** `AudioContext.sampleRate` is 44.1 or 48 kHz and cannot be forced on
  iOS. The modem defines everything in Hz and seconds and resamples internally (tested at
  48→44.1 kHz).
- **One `AudioContext`** per page, created and resumed in a user gesture. It is resumed again on
  `visibilitychange`. When iOS reports `interrupted`/`suspended`, the UI asks for a tap.

## Expected behaviour to verify, per platform

### iOS Safari (WebKit)

| Topic | Expectation | Bench test |
|---|---|---|
| `echoCancellation:false` | Recent WebKit can switch off voice processing, but has historically ignored or only partly applied constraints. Settings may report `false` while processing is still on. | Mic check: API layer (`getSettings`, `applyConstraints`) and the empirical AEC self-test |
| `noiseSuppression`, `autoGainControl` | Often missing from `getSupportedConstraints()`. If voice processing is active they are effectively on. | Mic check: AGC steps (slope ≈ 1 means off), NS long tone (decay or gating) |
| Voice-processing low-pass | When voice processing is on, the mic path may be band-limited well below 17 kHz, which kills the band. | Mic check: ambient noise 17–18.5 kHz vs 12–15 kHz, and a self-played 16–19 kHz sweep |
| Output routing | With a live mic track, output may go to the earpiece at low level. | Audibility/level with mic held vs released; frequency response from the other device |
| `navigator.audioSession.type` | `'playback'` should route to the speaker and ignore the silent switch. `'play-and-record'` keeps the mic. | Mic check: audioSession variants |
| Acquisition order | `getUserMedia` before vs after creating the `AudioContext` can change the route or rate. | Mic check: order variants |
| Backgrounding | The `AudioContext` is suspended or interrupted. Transfers stop. | Logged by the state listener |
| Sample rate | Usually 48 kHz, sometimes 44.1 kHz depending on route. | Device info |

### Android Chrome

| Topic | Expectation | Bench test |
|---|---|---|
| Raw constraints | Usually honoured. Some OEM HALs apply AEC or NS anyway, especially in "communication" mode. | Mic check |
| Mic/speaker response above 17 kHz | Varies a lot by model. Some roll off hard above 16 kHz. | Frequency response; pick the best sub-band if needed (the band can be shifted up, not down) |
| Audio effects | OEM "sound enhancers" can compress or EQ the output. | Frequency response, audibility |

### Desktop

Generally the most capable. Laptop speakers vary above 17 kHz, and laptops with "voice
isolation" can apply processing at the OS level (macOS has a per-app mic mode). The mic check
detects this.

## Measured results

| Device (TX → RX) | Browser / OS | fs | AEC off | AGC off | NS off | Band usable | Best 1.5 kHz sub-band | RT60 (s) | dB/m | Max range per profile | Export |
|---|---|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — | — | — | — |

## Known limitations (current)

- The long-range profile needs the phones to be roughly still. The simulated moving-hand case
  (±0.3 m/s) fails at SF ≥ 7 because the symbols are longer than the Doppler stays constant.
  The fast profile tolerates hand motion. See `sim/results/modem.md`, condition
  `motion-room`.
- 17 kHz is audible to many children and teenagers, and to some pets. Raise `fLow` for those
  audiences, but only if the bench shows both devices have usable response there.
- Throughput is physics-limited: about 1.3 kHz of usable band with robust non-coherent
  modulation. Kilobyte files take minutes (see `docs/PROTOCOL.md` §Throughput).
