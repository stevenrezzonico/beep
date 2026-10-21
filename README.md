# beep — data over near-ultrasound, in the browser

beep moves data between devices with sound in the **17.0–18.5 kHz** band. It runs in the
browser on desktop (Chrome, Edge, Firefox, Safari), Android (Chrome) and iOS (Safari/WebKit)
with no server-side processing. Priorities, in order: **distance**, then **silence**, then
**speed**.

| Part | What it is |
|---|---|
| [`bench/`](bench/) | Two-device lab bench: frequency response, mic-processing check (AEC/AGC/NS), echo/RT60 + IR export, attenuation vs distance, Doppler, audibility A/B, BER/PER per profile and per modulation candidate |
| [`sim/`](sim/) | Headless channel simulator (noise, 44.1↔48 kHz, reverb, Doppler, clock drift, speaker nonlinearity, interferers) and BER/PER studies; runs in CI |
| [`modem/`](modem/) | Chirp-spread-spectrum modem: pure functions over `Float32Array`, no Web Audio dependency |
| [`protocol/`](protocol/) | Bit-packed frames, rateless erasure-coded fragments, text codec, bounded reassembly |
| [`app/`](app/) | End-user site: Send / Receive |
| [`docs/`](docs/) | [Modulation evaluation](docs/MODULATION_EVALUATION.md), [protocol](docs/PROTOCOL.md), [decisions](docs/DECISIONS.md), [platforms](docs/PLATFORMS.md) |

The modem in one paragraph: LoRa-style chirp spread spectrum over 1.3 kHz (17.1–18.4 kHz).
The preamble is SF8 up- and down-chirps, followed by a Reed–Solomon-coded header and a K=7
convolutional-coded payload. There are three profiles (long-range SF8, balanced SF7, fast SF5).
The waveform has one frequency at a time, constant envelope, continuous phase, 2 ms frequency
glides and raised-cosine ramps. The receiver band-passes to the allowed band, detects with a
CFAR threshold, estimates Doppler and timing from the preamble, tracks them through the
packet, and reports per-packet diagnostics. Why these choices: see
[MODULATION_EVALUATION.md](docs/MODULATION_EVALUATION.md) and
[DECISIONS.md](docs/DECISIONS.md).

> **Status.** Everything is implemented and unit-tested, and validated **in simulation only**.
>
> Simulated packet error rate ≤ 10% (32-byte packets, SNR in the 1.5 kHz band, peak-referenced):
>
> | Profile | AWGN | Simulated rooms |
> |---|---|---|
> | long-range | −14.2 dB | −10.8…−11.2 dB |
> | balanced | −12.2 dB | −8.1…−8.8 dB |
> | fast | −5.0 dB | −2.1…+2.5 dB |
>
> - No silent corruption occurred in any simulated condition.
> - No false packets occurred in a 3-hour noise soak.
>
> **No real-device measurements exist yet.** Distance claims must come from the bench and are
> pending ([PLATFORMS.md](docs/PLATFORMS.md)).

## Run locally

Requires Node ≥ 22.12.

```sh
npm install
npm run dev          # http://localhost:5173 — landing page, /app/, /bench/
npm test             # all DSP/modem/protocol/bench unit tests (Node)
npm run typecheck
npm run build        # static site in dist/ (any static host works)
```

`localhost` is a secure context, so the microphone works on the desktop without HTTPS.

## Testing on phones (HTTPS on the LAN)

`getUserMedia` needs HTTPS on anything except `localhost`. There are three options.

1. **GitHub Pages (simplest).** On every push to `main`, CI builds the site and deploys it to
   Pages. Open `https://<user>.github.io/beep/` on both phones. Enable Pages once under
   *Settings → Pages → Source: GitHub Actions*. Pages on a private repository needs a paid plan.
2. **mkcert on the LAN.**
   ```sh
   brew install mkcert            # or your OS's package
   mkcert -install
   mkdir -p cert
   mkcert -key-file cert/key.pem -cert-file cert/cert.pem <your-LAN-IP> localhost
   npm run dev:lan                # serves https://<your-LAN-IP>:5173
   ```
   Phones must trust the mkcert root CA:
   - **iOS:** AirDrop/mail `$(mkcert -CAROOT)/rootCA.pem` to the phone, install the profile,
     then enable it under *Settings → General → About → Certificate Trust Settings*.
   - **Android:** *Settings → Security → Install certificate → CA certificate*.
3. **A tunnel.** For example `npx cloudflared tunnel --url http://localhost:5173` (or ngrok)
   gives a public HTTPS URL without installing certificates. Audio is processed only on the
   devices, but the page is then publicly reachable while the tunnel runs.

## Simulator

```sh
npm run sim                          # all studies, full statistics (tens of minutes), writes sim/results/
npm run sim:quick                    # reduced sweeps (what CI runs), writes sim/out/
npm run sim -- --only candidates     # or: modem | preamble | falsealarm | fec | tracking | loss | smoothing
npx tsx protocol/text/eval.ts        # text codec comparison
```

Results committed in [`sim/results/`](sim/results/) are what the docs cite. Bench-measured room
impulse responses saved to `sim/ir/*.json` are picked up automatically as extra channel
conditions.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and PR:

- typecheck and the unit tests;
- the quick simulator sweep, with curves uploaded as the `sim-curves` artifact;
- the static build;
- on `main`, the deploy to GitHub Pages.

## Layout of the code

- `src/dsp/`: FFT, Kaiser FIR design, chunk-invariant downconverter (the receive band-pass),
  fractional interpolation, spectra, the bench sync marker.
- `modem/`:
  - `css.ts`: chirp synthesis/dechirp
  - `tx.ts`: packet → waveform
  - `rx.ts`: streaming receiver
  - `frame.ts`: header/payload coding
  - `fec/`: convolutional/Viterbi, Reed–Solomon, CRC, interleaver
  - `candidates/`: the other modulations evaluated
- `protocol/`: `frame.ts` (bit layout), `message.ts` (fragmentation and reassembly), `rlnc.ts`
  (erasure code), `text/` (codec, corpus, evaluation).
- `web/`: shared browser audio layer (one `AudioContext`, mic with raw constraints and
  half-duplex release, playback, iOS `audioSession`, spectrum view, export).
