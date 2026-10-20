# Modulation evaluation for beep

**Goal, in priority order:** (1) distance, (2) silence, (3) speed, within 17.0–18.5 kHz. Every
claim here is analysis or simulation. Where the bench later measures something different, the
measurement wins and this document is updated. Numbers come from `sim/results/` (reproducible
with `npm run sim`).

## 1. The channel, in numbers

| Quantity | Value | Consequence |
|---|---|---|
| Allowed band | 17.0–18.5 kHz (1.5 kHz) | All signalling must fit in 1.5 kHz |
| Occupied band | 17.1–18.4 kHz (**BW = 1.3 kHz**), 100 Hz guards for filter transitions (D-002) | Every rate below uses 1.3 kHz |
| Wavelength at 17.75 kHz | 1.93 cm | Millimetres of motion or a reflection change the phase: **prefer non-coherent detection** |
| Doppler | 51.7 Hz per m/s | 0.1 m/s = 5 Hz = **one FFT bin at SF8**. Frequency offset must be estimated, not tolerated |
| Clock mismatch | ~±50–100 ppm | 0.9–1.8 Hz carrier error (negligible), but 50–100 µs of timing drift per second |
| Air absorption | ≈0.5–1 dB/m indoors at 18 kHz, plus 6 dB per distance doubling | The bench measures the actual dB/m |
| Room reverb | RT60 ≈ 0.3–0.6 s at high frequency (furnished to bare room) | Tails last 10–100× a fast symbol. Symbol design must tolerate this rather than wait it out |
| Speaker | Peak-limited, nonlinear near full scale | High PAPR costs range one-for-one; simultaneous tones produce audible difference tones |

**SNR convention (D-003).** SNR is the power of a full-peak sine divided by the noise in the
1.5 kHz band. Each waveform is therefore charged for its peak-to-average ratio, because the
speaker clips at the peak, not at the average.

## 2. Candidates and their numbers in this band

Raw rates for the occupied 1.3 kHz. The brief's figures assume 1.5 kHz and are about 15%
higher.

| Family | Variant simulated | Symbol | Raw bit/s | Envelope | Notes |
|---|---|---|---|---|---|
| OOK/ASK | on/off of 17.75 kHz, 2 ms RC edges | 10 ms | 100 | **not constant** | Half the symbols are silent; onsets everywhere |
| BFSK | Δf = 100 Hz, continuous phase | 10 ms | 100 | constant | 1 bit/symbol |
| MFSK, orthogonal | 32 tones, Δf = 1/T = 40.6 Hz | 24.6 ms | 203 | constant | Same rate as CSS SF5 |
| MFSK, wide spacing | 16 tones, Δf = 2/T | 24.6 ms | 163 | constant | More Doppler tolerance per tone |
| MFSK + hopping | 2 interleaved groups of 16 | 24.6 ms | 163 | constant | Consecutive symbols on disjoint tones (reverb) |
| MFSK + guard | 32 tones, +10 ms extension | 34.6 ms | 144 | constant | Detection skips the reverberant head |
| MFSK, orthogonal | 128 tones, Δf = 10.2 Hz | 98.5 ms | 71 | constant | Same rate as CSS SF7 |
| CPFSK/GMSK | h = 0.5, BT = 0.5, 1-bit differential detection | 1 ms | 1000 | constant | Spectrally compact |
| DBPSK | 800 Bd, RRC β = 0.5 | 1.25 ms | 800 | **not constant** | Differential detection |
| DSSS | L = 31 m-sequence, 800 chip/s, DBPSK on bits | 39 ms | 26 | **not constant** | 15 dB processing gain |
| OFDM (differential) | 32 carriers, DBPSK in time, 10 ms CP | 35.6 ms | 899 | **not constant** | Many tones at once |
| **CSS (LoRa-style)** | SF5…SF9, cyclic shift, dechirp + FFT | 2^SF / BW | SF5 24.6 ms / 203; SF6 49 ms / 122; SF7 98.5 ms / 71; SF8 197 ms / 41; SF9 394 ms / 23; (SF11 1.58 s / 7) | constant | One tone at a time sweeping the whole band |

Implementations: `modem/candidates/`. All candidates share the same channel model and the same
genie timing, and **none is told the carrier offset**. The comparison therefore isolates each
modulation's own robustness from synchronisation design.

## 3. Results (uncoded, genie timing, 48 kHz TX → 44.1 kHz RX)

RESULTS_CANDIDATES

Channel conditions (`sim/conditions.ts`):
- **awgn:** noise only.
- **room-near:** RT60 0.3 s, direct-to-reverberant ratio (DRR) +6 dB, cubic speaker, −6 dB tilt
  across the band, 50 ppm.
- **room-far:** RT60 0.6 s, DRR −3 dB, otherwise as room-near.
- **doppler:** constant 0.5 m/s.
- **motion-room:** ±0.3 m/s hand motion in the near room.

Plots: `sim/results/ber-*.svg`.

## 4. Assessment against the priorities

### Distance (required SNR, multipath, Doppler)

- **Energy efficiency.** Non-coherent orthogonal M-ary signalling (MFSK, CSS) gets more
  efficient with M: each doubling of M buys about 3 dB of sensitivity for twice the symbol time.
  CSS SFx and orthogonal MFSK with 2^x tones are the same signal set in AWGN, and the
  simulation shows them within the noise of each other. Binary schemes (OOK, BFSK, GMSK, DBPSK)
  need about 10–20 dB more SNR at the same error rate, and therefore lose range directly.
- **Multipath.** This is where CSS separates from MFSK. De-chirping maps an echo delayed by τ to
  a peak shifted by τ·BW bins. The diffuse reverberant tail is spread over many bins and treated
  as noise, so the processing gain applies to it, and the room's frequency-selective nulls are
  averaged out because every symbol sweeps the whole band. An MFSK tone sits on one frequency:
  - a standing-wave null at that frequency erases it;
  - the previous symbol's tail lands on a competing bin.

  Hopping and guard extensions help (see the rows). OOK fails outright because reverb fills the
  "off" symbols. The short-symbol coherent or differential schemes (GMSK, DBPSK) see delay
  spreads of tens of symbols and would need equalisers, which is fragile at 1.9 cm wavelength.
- **Doppler.** Nothing simulated survives 0.5 m/s at long symbols *without* frequency-offset
  estimation: a 26 Hz shift is 2.6 bins at SF7. That is a property of narrow bins, not a flaw of
  CSS, and every long-symbol scheme needs estimation. CSS has the cleanest estimator: up-chirps
  measure (offset − timing), down-chirps measure (offset + timing), and the real modem separates
  them to 0.1 Hz and a few µs from −1.5 to +1.9 m/s (D-012, D-020). Short symbols (BFSK,
  wide-spaced MFSK) tolerate Doppler without estimation but pay for it in sensitivity.
- **Synchronisation.** CSS preambles are matched to the signal and detectable below the noise
  floor, with a CFAR threshold. Repeated up-chirps produce the *same* FFT bin whatever the window
  alignment, so the detection grid needs no timing search. MFSK and DSSS preambles need a timing
  search or a separate correlator.

### Silence (PAPR, intermodulation, clicks, audible patterns)

- **PAPR.** Constant-envelope schemes have 3 dB (a sine). OOK and DBPSK/DSSS lose 1–4 dB more.
  OFDM loses about 13 dB: under the peak-referenced SNR that is 10 dB of range (roughly ÷3
  distance in free field), before counting the audible products below.
- **Intermodulation.** The cubic speaker model reproduces the brief's warning. Any scheme with
  simultaneous tones (OFDM, and the multi-tone FSK used by ggwave) creates difference and
  2f1−f2 products in the audible range. Single-tone schemes (CSS, MFSK, BFSK, GMSK) show *no*
  increase of leakage after the nonlinearity (the "after k3" column equals the clean one).
- **Clicks.** Abrupt onsets and frequency steps are broadband. The table's "<16 kHz" column
  shows:
  - OOK onsets and RRC-shaped PSK transitions leak more than constant-envelope schemes;
  - phase-continuous FSK still leaks at each frequency step;
  - CSS leaks at its frequency wrap until the steps are smoothed. A 2 ms glide (D-007) takes
    CSS from −38 to −69 dBc below 16 kHz at SF5, and to −75/−80 dBc at SF7/SF9 (§5).
- **Audible patterns.** The repeated identical up-chirps of the preamble are the only rhythmic
  part (8 × 197 ms). Payload chirps are pseudo-random shifts. Total air time is short.

### Speed

At a given robustness, CSS and MFSK are equal in AWGN, and CSS wins in rooms. The fast schemes
(GMSK at 1 kbit/s, DBPSK at 800 Bd, OFDM at about 900 bit/s) are 5–40× faster *on paper*, but
in the simulated rooms they hit error floors or need 10–25 dB more SNR. By the priorities that
disqualifies them: a 5× speed gain that only works at arm's length in a quiet, dead room is not
worth the complexity of a second waveform. The fast CSS profile (SF5, code rate ⅔, ~135 net
bit/s) is the speed option.

### Receiver complexity (AudioWorklet / main thread)

CSS needs one N-point FFT per symbol (N = 32…256) plus a polyphase downconverter. The whole
receiver runs at 0.7% of real time in Node (D-021). MFSK is similar. OFDM is similar per symbol
but needs channel estimation. Coherent or equalised schemes are the most complex and the least
robust.

## 5. Time-domain parameters

- **Symbol length vs reverb.** CSS needs no guard interval. The reverberant tail of the previous
  symbol is spread across the dechirped spectrum like noise, and the far-room condition
  (RT60 0.6 s, DRR −3 dB) decodes SF7 at about the same SNR as near-room. The bench echo test
  measures real RT60 and exports impulse responses, which `sim/` loads as extra conditions
  (`sim/ir/*.json`).
- **Frequency glide** (smoothing study, `sim/results/smoothing.md`):

RESULTS_SMOOTHING

- **FEC and interleaving**: see [`sim/results/fec.md`](../sim/results/fec.md) and D-013.

Payload FEC comparison on SF7 CSS with genie timing (32-byte payloads). Cells: SNR (dB) for PER ≤ 10% / ≤ 1%, and the code rate.

| Scheme | rate | awgn | room-far |
|---|---|---|---|
| uncoded (CRC only) | 1.00 | -8.8 / -7.3 | -3.2 / -2.0 |
| Hamming(7,4) soft ML + interleaver | 0.57 | -10.3 / -9.5 | -4.4 / -3.0 |
| RS shortened, n=2k (hard, errors-only) | 0.50 | -11.2 / -11.0 | -5.4 / -4.5 |
| K=7 conv r=1/2 soft Viterbi, no interleaver | 0.50 | -10.5 / -9.3 | -4.0 / -1.0 |
| K=7 conv r=1/2 soft Viterbi + interleaver | 0.50 | -12.1 / -11.3 | -7.1 / -6.3 |
| K=7 conv r=2/3 (punctured) + interleaver | 0.67 | -11.2 / -11.0 | -6.3 / -5.0 |

The convolutional code with soft decisions and interleaving wins in both conditions. The interleaver alone is worth 1.6–3.1 dB (D-013, D-019).

## 6. Hybrids considered

| Hybrid | Verdict |
|---|---|
| CSS preamble + MFSK payload | No gain. MFSK equals CSS in AWGN and is worse in rooms. |
| CSS preamble + GMSK/DQPSK "near" payload | Possible future profile (profile id 3 is reserved) if the bench shows a stable high-SNR, low-reverb case. The simulated rooms put it in an error floor, so it is not built now. |
| CSS with SF per profile, one preamble and header | **Chosen.** Any receiver decodes any profile without configuration. |
| LoRa-style "low data-rate optimisation" (using SF−2 bits per symbol) | Not needed. The tracking loop and Gray mapping keep ±1-bin errors rare, and the soft Viterbi decoder absorbs the rest. |

## 7. Lessons from prior art (studied, not copied)

- **ggwave.** Multi-tone FSK with Reed–Solomon, cross-platform including browsers, with audible
  and ultrasonic protocols. Lessons:
  - simultaneous tones mean intermodulation and higher PAPR, so we keep one tone at a time;
  - RS on bytes is a good outer code for short messages.
- **quiet.js / libquiet.** Profiles from GMSK to OFDM, including experimental ultrasonic ones.
  Lessons:
  - high-rate profiles are close-range only;
  - OFDM profiles need careful amplitude handling;
  - a profile system, with sender-selected robustness, is the right user model.
- **Chirp (chirp.io).** Short audible MFSK "bird song" carrying short identifiers. Lesson:
  extreme bit economy, short messages, short air time. We encode the content itself, so compact
  text coding matters (PROTOCOL §6).
- **amodem.** Coherent QAM/OFDM at high rates over a cable or a few centimetres. Lesson:
  coherent modes belong to stable channels, not rooms.
- **minimodem.** Bell-style BFSK. Lesson: a robust, simple baseline, but 1 bit per symbol wastes
  energy. M-ary signalling buys sensitivity.
- **LoRa.** CSS with SF selection, a preamble of up-chirps plus 2.25 down-chirps, Gray mapping,
  a diagonal interleaver, and Hamming codes. Lessons:
  - CSS's processing gain and its up/down-chirp separation of frequency and timing offset, both
    adopted;
  - the weak FEC (Hamming, hard decisions) leaves several dB on the table, so we use a soft K=7
    Viterbi (BICM) instead;
  - the 0.25 down-chirp is unnecessary with an aligned sync search (D-008).
- **Acoustic-communication papers.**
  - Chirp-based aerial acoustic links report tens of metres at tens of bit/s in
    near-inaudible bands.
  - OFDM-based near-field systems reach higher rates at centimetre-to-metre range.
  - Both agree with this analysis: range comes from processing gain and non-coherence, rate
    from coherence and short range.

## 8. Recommendation and fallback

**Recommendation: CSS for everything.**

- Preamble: SF8, 8 up + 4 down-chirps.
- Header: Reed–Solomon-coded, 8 chirps.
- Payload profiles: long-range SF8 r½, balanced SF7 r½, fast SF5 r⅔.
- Waveform: constant envelope, continuous phase, 2 ms frequency glides, raised-cosine ramps.

Measured modem performance (own synchronisation, header, tracking and FEC):
[`sim/results/modem.md`](../sim/results/modem.md).

**Simulated modem PER.** Packet error rate of the full modem (own sync, header, tracking, Viterbi, CRC) for 32-byte payloads, 48 kHz TX → 44.1 kHz RX. SNR is peak-referenced in the 1.5 kHz band (sim/channel.ts). Cells: SNR for PER ≤ 10% / ≤ 1%.

| Profile | SF | code | net bit/s | air time 32 B (s) | awgn | room-near | room-far | doppler | hand-held | motion-room | silent corruptions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| long-range | 8 | 1/2 | 20.3 | 17.72 | -13.0 / -11.3 | -9.6 / -9.1 | -8.4 / -8.0 | -13.0 / -10.3 | n/a / n/a | n/a / n/a | 0 |
| balanced | 7 | 1/2 | 35.5 | 11.82 | -12.0 / -11.1 | -8.3 / -7.2 | -7.6 / -7.1 | -11.7 / -10.3 | n/a / n/a | n/a / n/a | 0 |
| fast | 5 | 2/3 | 135.4 | 6.01 | -5.3 / -0.3 | -2.1 / 3.9 | 2.0 / 3.9 | -5.3 / -4.3 | 11.0 / n/a | n/a / n/a | 0 |

Reading the table:

- **Static devices.** In AWGN the profiles reach PER ≤ 10% at −13.0 (long-range), −12.0
  (balanced) and −5.3 dB (fast). In the simulated rooms, where reverb and the speaker model
  apply, the figures are −8 to −9.6 dB. No packet in any condition passed CRC with wrong
  content.
- **Constant motion** (0.5 m/s) costs nothing: Doppler is estimated and tracked.
- **Hand-held sway** (±0.1 m/s every 2 s) is tolerated only by the fast profile, whose 25 ms
  symbols see almost no Doppler change. Long symbols (SF7/SF8, 98–197 ms) smear when the
  velocity changes within a symbol. **The long-range and balanced profiles need the phones
  roughly at rest**, for example on a table or held still. In separate runs (D-012), sway of
  ±0.05 m/s with a 4 s period decoded 12/12 packets on balanced.
- **Waving** (±0.3 m/s every 2 s) defeats every profile, because the SF8 preamble and header
  cannot follow it.
- **Open item.** Long-range is only about 1 dB more sensitive than balanced in AWGN, where SF8
  should be about 2.5–3 dB better. Roughly 1.5 dB of implementation loss remains in the SF8
  path. Suspects are the soft-metric scaling at low SNR and loop jitter over 70 symbols.

**Fallback: interleaved-hopping MFSK.** 16-FSK with 2 hop groups at 24.6 ms, wrapped in the same
preamble, header and FEC. The case for it:

- it is the best non-CSS candidate in the reverberant conditions and under Doppler;
- it tolerates more motion at short symbols;
- the tone-set approach is simpler to tune per device if the bench finds narrow dead spots in a
  device pair's response;
- the modem's preamble, header, FEC and protocol are independent of the payload modulation, so
  switching costs one demodulator.

Choose it if the bench shows CSS failing in a way the simulator missed: for example a speaker
whose response collapses across part of the band, which a CSS chirp must cross and an MFSK
tone set can avoid.

**Confirmation status.** The recommendation is confirmed by the simulator. It is **not yet
confirmed by the real-device bench**: no device runs have been logged
([PLATFORMS.md](PLATFORMS.md)). The bench's BER/PER mode compares every candidate above and every
modem profile on real devices. Its results decide whether this document stands.
