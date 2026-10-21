# Design decisions

Each entry gives the decision, the evidence for it (a simulation result in `sim/results/`, a
measurement, or an argument from physics), and what was rejected. If a later real-device
measurement contradicts an entry, the measurement wins and the entry is revised.

Status labels: **sim** = backed by the simulator; **analysis** = derived from physics or
standards; **pending-bench** = must be confirmed on devices.

---

### D-001 Modulation: chirp spread spectrum (LoRa-style), all profiles — *sim, pending-bench*

**Decision.** CSS with data as cyclic shift, de-chirp + FFT detection. Spreading factor selects
the robustness/speed trade-off.

**Evidence.**
- Under the uncoded comparison in [`sim/results/candidates.md`](../sim/results/candidates.md),
  CSS is the only family that still works in the reverberant far-field room.
- CSS ties MFSK in AWGN at equal rate, as theory predicts (both are orthogonal M-ary signalling).
- It keeps a constant envelope, so PAPR is 3 dB (a sine).
- It has no intermodulation: the leakage after the cubic speaker model equals the clean
  leakage.

**Rejected.**
- OOK: it loses its PAPR in range, and reverb fills the "off" symbols.
- GMSK, DBPSK and coherent schemes: they need phase coherence and an equaliser in rooms.
- DSSS: carrier offset destroys despreading coherence, and shaped chips are not constant
  envelope.
- OFDM: 13 dB PAPR charged against a peak-limited speaker, plus audible intermodulation.
- MFSK: it fails in reverb unless hopping or guard time is added, and its narrow tones fall into
  standing-wave nulls.

Full analysis: [MODULATION_EVALUATION.md](MODULATION_EVALUATION.md).

### D-002 Band 17.0–18.5 kHz, 100 Hz guards, occupied 17.1–18.4 kHz (BW = 1.3 kHz) — *analysis, pending-bench*

**Decision.** `fLow`/`fHigh` default to the brief's limits and are parameters (`modem/band.ts`).
The guard is the receive filter's transition band: the filter passes ±650 Hz around 17.75 kHz
and rejects ±750 Hz by ≥ 60 dB (`src/dsp/dsp.test.ts`). So nothing outside 17.0–18.5 kHz reaches
detection, and the transmitter's own skirt is attenuated before 17.0 kHz.

**Rejected.** Occupying the full 1.5 kHz: it needs a brick-wall filter, and puts the chirp
edges, where spectral splatter lives, right at 17.0 kHz.

**To confirm.** Use the bench frequency-response test to find the best sub-band per device
pair. The band may be shifted up (e.g. 17.5–19.0 kHz) where both devices respond. Never shift
it down by default.

### D-003 SNR convention: peak-referenced, 1.5 kHz noise band — *analysis*

All SNRs in this repo are the power of a full-peak sine (A²/2) over the noise power in
17.0–18.5 kHz. Referencing the **peak** charges every waveform for its peak-to-average ratio. A
phone speaker is peak-limited, so OOK or OFDM must back off by their PAPR and lose that much
range. That loss is real, and an average-power SNR would hide it.

### D-004 Sample-rate agnostic DSP — *analysis, sim*

**Decision.** Everything is specified in Hz and seconds. The receiver downconverts to complex
baseband and reads it at arbitrary instants with a Kaiser-windowed-sinc interpolator, so chip
instants never need to fall on device samples.

**Evidence.** Every simulation transmits at 48 kHz and receives at 44.1 kHz. Unit tests check
both rates.

**Rejected.** Integer samples per chip. That forces BW to divide both 44.1 and 48 kHz, ties the
band to the device, and breaks under clock offset.

### D-005 Receive band-pass = complex downconversion + two-stage Kaiser decimation — *analysis, tested*

Stage 1 decimates cheaply while protecting ±750 Hz. Stage 2 is the sharp channel filter (pass
±650 Hz, 60 dB at ±750 Hz). Filters are designed at run time from the spec in Hz. The
downconverter is stateful and chunk-invariant: its output is bit-identical for any chunking
(tested), which detection determinism depends on.

### D-006 Half-duplex — *analysis, pending-bench*

**Decision.** Never hold a mic track while transmitting.

**Why.**
- iOS routes output to the earpiece in play-and-record mode.
- Broadcast-first (user decision) makes transfers one-way anyway.

An ACK/NEED back-channel exists in the protocol. It is only enabled where the bench shows the
link can be turned around.

### D-007 Frequency glide 2 ms at every frequency step — *sim*

**Decision.** Phase continuity alone is not enough. The chirp's frequency wrap (18.4 → 17.1 kHz)
is still a step in instantaneous frequency, and its spectral skirt reached −38 dBc below 16 kHz
at SF5. Smoothing the frequency trajectory with a 2 ms Hann kernel (GFSK-style) leaves the
linear chirp segments untouched and pushes the skirt down.

**Evidence** ([`sim/results/smoothing.md`](../sim/results/smoothing.md)):
- Leakage below 16 kHz falls from −38 to −69 dBc (SF5), from −45 to −75 (SF7) and from −50 to
  −80 (SF9).
- The AWGN cost is not measurable.
- 1.5 ms is the shortest glide that keeps SF5 ≤ −60 dBc below 16 kHz. 2 ms adds margin.

The bench audibility test independently found the same: phase-continuous hops leaked −48 dBc
below 16 kHz, and smoothed transitions −105 dBc.

**Rejected.** Longer glides. They cost a larger fraction of an SF5 symbol (2.6 of 32 chips at
2 ms) for leakage already far below hearing thresholds.

### D-008 Preamble: SF8, 8 up-chirps + 4 down-chirps, 8-chirp header, no LoRa quarter chirp — *sim*

**Evidence.** [`sim/results/preamble.md`](../sim/results/preamble.md): the long-range profile
with 8-byte payloads, 50 packets per point, final receiver. Cells are the SNR (dB) where
≥ 90% of packets sync / decode the header / decode the packet:

| Preamble (+ header) | air time | AWGN | far room |
|---|---|---|---|
| 6↑ 2↓, header 5 | 2.56 s | −13 / −13 / −13 | −9 / −9 / −9 |
| 6↑ 4↓, header 6 | 3.15 s | −14 / −13 / −13 | −11 / −10 / −10 |
| 6↑ 4↓, header 8 | 3.54 s | −14 / −14 / −14 | −11 / −10 / −10 |
| **8↑ 4↓, header 8 (chosen)** | **3.94 s** | **−15 / −14 / −14** | **−11 / −11 / −10** |
| 10↑ 4↓, header 8 | 4.33 s | −15 / −14 / −14 | −11 / −10 / −10 |
| SF9 5↑ 3↓, header 5 | 5.12 s | −16 / −16 / −14 | −12 / −12 / −10 |

- Going from 2 to 4 down-chirps and from 5 to 8 header chirps buys about 1 dB each.
- 8 up-chirps sync 1 dB below 6, a margin for longer packets and for real rooms. They decode
  8-byte packets at the same SNR, and cost 0.4 s more per packet. Distance comes first, so 8.
  The difference is at the edge of the study's resolution (1 dB steps, 50 packets).
- An SF9 preamble syncs 1 dB lower again, but the packet is then limited by the SF8 payload and
  it costs 1.2 s more.
- With 32-byte packets and the receiver fixes of D-012, sync and header pass 90% at −14.8 /
  −14.5 dB. The genie-timed SF8 payload passes at the same SNR (−14.5 dB,
  [`loss.md`](../sim/results/loss.md)), so preamble and payload are now balanced.

The up-chirps give detection and Δ−d (carrier offset minus timing). The down-chirps give Δ+d.
More down-chirps help most: two down-chirps were the bottleneck, because sync must choose among
about 1,700 carrier×boundary hypotheses with only two symbols of evidence. LoRa's 0.25
down-chirp exists so that one full window lands inside the down-chirps. Our aligned search does
not need it, so it is dropped (saves 49 ms).

### D-009 Detection thresholds derived from false-alarm probability (CFAR) — *analysis, sim*

No level-based constants.

- **Detection.** Sum over K = nUp−1 up-chirp windows of adjacent-bin pairs, divided by the
  window's own mean bin power. Under noise this is ≈ Gamma(2K). The threshold solves
  N·Q(2K, x) = 10⁻⁶ per window.
- **Sync validation.** The down-chirp evidence (best of ±1 bin in each of nDown windows) uses a
  union bound over all hypotheses searched, at 10⁻³.
- **Header acceptance.** The ML codeword's summed bin power must beat the best of 4,096 noise
  codewords at 10⁻⁴.

**Evidence.** The noise-only soak in
[`sim/results/false-alarm.md`](../sim/results/false-alarm.md) (white noise, a strong 17.6 kHz
tone, clicks) produces no false packet. Because the statistics are ratios within one FFT,
detection is independent of absolute level, of AGC (if the platform refuses to disable it) and
of the noise floor.

### D-010 Transmit level: −6 dBFS peak by default, user-adjustable — *analysis, pending-bench*

**Decision.** Default peak amplitude 0.5. Output chains (browser limiter, OS mixer, amplifier)
start compressing near full scale, and speaker excursion nonlinearity rises with level. The
cubic model shows a single-tone signal has no audible IMD even when overdriven, so the main risk
of more level is distortion of the amplifier and transducer, not audibility.

**Range trade.** Every +6 dB of level is worth about +6 dB of link margin. The app warns above
−1 dBFS. The bench audibility test with self-recorded IMD measures the real limit per device.

### D-011 PHY header: 12 bits, Reed–Solomon (8, 2) over GF(256), soft ML decoding — *sim*

**Decision.** The header carries profile (2), length−1 (8) and reserved (2). The two bytes are
the information symbols of an RS(8, 2) codeword, one GF(256) symbol per chirp (bin
v·2^(SF−8)). It is decoded by maximum likelihood over all 4,096 headers and over a common bin
offset δ ∈ {−2…+2}, using the non-coherent symbol metrics ln I0(·). It is accepted only if all
of these hold:

1. the evidence beats noise (D-009);
2. at least 5 of the 8 chirps peak within ±1 bin of the decoded codeword;
3. the reserved bits are 0.

The payload CRC-16 also covers the header fields, so a wrongly accepted header cannot produce a
corrupt packet.

**Why each part.**
- *Symbol-level code.* The first design was 20 bits (with CRC-8) under a rate-½ tail-biting
  convolutional code, giving 5 SF8 chirps. It failed 20–30% of headers at SNRs where payloads
  decoded: with so few symbols, one wrong chirp corrupts 8 of 40 coded bits, a burst no
  bit-level code fixes. Any two RS(8,2) headers differ in at least 7 chirps.
- *Offset δ.* In chirp modulation, a carrier offset of one whole bin is indistinguishable from
  data +1. At SF8 (5 Hz bins) a velocity change of 0.05 m/s between preamble and header shifts
  every header chirp by a bin. Measured: 0/12 headers at ±0.05 m/s sway before, 12/12 after.
  The decoded δ re-anchors the carrier estimate for the payload.
- *Consistency check.* Real chirps read at the wrong alignment (a sync one symbol off, another
  packet's chirps) are strong. With k = 2, *some* codeword matches any two of them, so evidence
  alone accepted them (measured once in 16 packets, blocking the receiver for a wrong payload
  length). Requiring 5 of 8 agreeing chirps rejects that. The ±1-bin tolerance allows for the
  carrier drifting within the 1.6 s header under sway.

**Rejected.**
- Conv code + CRC-8 (above).
- LoRa's Hamming-coded header, for the same reason plus weak distance.
- Per-chirp ±1 tolerance inside the ML metric itself: three times as many noise candidates per
  chirp, costing sensitivity in the static case that matters most for range.

### D-012 Tracking: time scale from the preamble, early/late timing loop, carrier re-anchored at the header — *sim* ([`sim/results/tracking.md`](../sim/results/tracking.md))

Doppler and clock offset are one physical effect, a time scaling 1+ε. The preamble estimates ε
(carrier offset / fc). The sync search uses ε-consistent window spacing and chip rates; without
it the boundary drifts ε·N chips per symbol and biases the estimate (measured: −3.4 Hz bias at
0.4 m/s before the fix, 0.1 Hz after). Inside the packet:

1. **ε stays at the preamble value.** Its precision therefore matters: an error of ε·T accumulates
   over a packet of length T. The fractional-bin estimates from the aligned preamble windows leave
   ≈ ±0.3 Hz of carrier error near the sensitivity limit, which is ±17 ppm, or up to 0.5 chip of
   timing drift over a 14 s long-range packet. The receiver therefore refines the carrier from the
   **phase advance between consecutive identical preamble chirps** (Σ X_{k+1}·X_k* over bins
   −1…1 of the 7 aligned up-chirps and 4 down-chirps). That measures Δf modulo 1/Ts ≈ 5 Hz. The
   fractional estimate resolves the ambiguity, since it is accurate to 0.3 Hz against a ±2.5 Hz
   window. Measured at −12 dB in AWGN: carrier error ≈ 0.03 Hz instead of 0.1–0.5 Hz, and
   estimated-velocity error 0.001 instead of 0.004 m/s (`modem-estimators.md`).
   The refinement is valid only while the carrier stays within ±2.5 Hz of its mean across the
   preamble. Hand-held sway (±0.1 m/s ⇒ ±5 Hz) wraps the per-chirp phase advance. An unguarded
   first version cut balanced under sway from 27/30 to 17/30 packets. The phasors are therefore
   used only if their coherence |Σ c_k| / Σ |c_k| is ≥ 0.7. Measured coherence, 20 packets each:
   static channels ≥ 0.64 down to −17 dB (median 0.89–0.97), sway 0.14–0.16, waving ≤ 0.5.
   Below the threshold, the fractional estimate stands, as before.
2. **Carrier.** Re-anchored once on the decoded header (common bin offset + residual, D-011).
3. **Timing.** A decision-directed type-2 **early/late gate** runs on confident symbols (peak ≥
   4·ln N × noise mean). It compares the energy around the decided peak in windows ¼ chip early
   and late. A fractional timing error δ puts a 2π·δ phase jump into the de-chirped tone at the
   chirp's frequency wrap, splitting the peak in a data-dependent way that de-rotation cannot
   fix. Measured: ±0.6–1.5 bins of jitter at ±0.05 m/s without the loop, ±0.1 with it. Gains:
   0.3 chip and 0.02 chip per unit of normalised early/late error. The integral paths take
   **1/g of an error measured g symbols after the previous update**, because that error is the
   drift of g symbols. Near the long-range limit only 5–10 of 70 payload symbols pass the gate.
   Without this scaling, one noisy update set a rate that then ran open-loop for the next dozen
   symbols, which gave timing ramps of 0.3–0.5 chip over a packet. With dense updates (g = 1,
   the fast profile under motion) the loop is unchanged.
4. **Residual whole-bin lock.** If a timing jump leaves the payload one bin off, it is decoded at
   shifts 0, −1 and +1 and kept only if the CRC passes. That raises the CRC-16 undetected-error
   bound from 2⁻¹⁶ to 3·2⁻¹⁶ per failed packet.

**Evidence for the loop configuration.** Targeted runs, 12–16 packets each:

| Loops (gate) | long-range AWGN, packets OK of 16 at −10 / −12 / −13 dB | fast, ±0.1 m/s sway | balanced, ±0.05 m/s sway |
|---|---|---|---|
| carrier only (4) | 15 / 15 / 14 | 1/12 | 3/12 |
| carrier + timing 0.3/0.02 (4) | 16 / 16 / 14 | 10/12 | 12/12 |
| carrier + timing 0.3/0.02 (8) | 16 / 15 / 15 | 10/12 | 12/12 |
| carrier + timing 1/0.1 (4) | 13 / 11 / 12 | 12/12 | 12/12 |
| timing only 0.3/0.02 (8) | 16 / 16 / 11 | 12/12 | 12/12 |
| **timing only 0.3/0.02 (4), chosen** | **16 / 15 / 16** | **12/12** | **12/12** |

These statistics resolve differences of about 1 dB, not finer. The table predates the ε and
1/g changes below.

**Re-checked after those changes** ([`tracking.md`](../sim/results/tracking.md) has the full
sweep). Targeted runs, 30 packets each, packets OK at 0 / −3 dB for fast under hand-held sway:
the original receiver 27 / 17, the current one 26 / 16, the current one without the timing
integral (`trackTI` = 0) 18 / 8. The integral is still needed under sway, and the defaults stay.

**Rejected.**
- A per-symbol **carrier loop** (de-rotation driven by the residual fractional bin offset). It
  adds noise near threshold and, under motion, chases offsets that are really timing. It is still
  available (`trackP`/`trackI`).
- **Feeding carrier changes back into ε** ("velocity ⇒ timing"). It looks physically right, but
  hand motion makes velocity oscillate. The timing error stays bounded by the displacement (±1–3
  cm ⇒ ±0.04–0.1 chips), whereas integrating transient carrier estimates into ε grows without
  bound. Measured: 1.5 chips after 4 s at ±0.05 m/s.
- **Higher timing gains** (1 / 0.1). They track sway marginally better but jitter the windows
  near the sensitivity limit. Distance comes first.

**Long-range implementation loss (found and fixed).** Before the two changes above, long-range
reached PER ≤ 10% at −13.0 dB in AWGN (−12.7 dB in the final pre-fix sweep), only 1–1.7 dB
better than balanced. Theory, and the
genie-timed SF8 row of `fec.md`, put it about 2.5–3 dB better. Diagnosis: the receiver and a
genie-timed decode ran on the same noisy samples (120 packets per point, AWGN). The genie used
the true payload start, time scale and carrier, and the receiver's own normalisation, soft metric
and Viterbi. Results:

| Variant at −14 dB (long-range, 32 B) | sync | header | packet OK | payload SER | genie SER |
|---|---|---|---|---|---|
| receiver before the fix | 98% | 97% | 71% | 25% | 10% |
| … with oracle Es in the soft metric | | | 71% | | |
| … with the tracking loop off | | | 70% | 26% | |
| … with genie ε (true time scale from the header on) | 98% | 97% | 96% | 12% | 10% |
| … with genie ε, timing and carrier, loop off | 98% | 98% | 98% | 11% | 10% |
| **receiver after the fix** | **98%** | **98%** | **97%** | **12%** | **10%** |

- **ε from a noisy preamble carrier: ≈ 1.2 dB, recovered.** The time-scale error drifted the
  payload timing by up to 0.5 chip (a half-bin peak split plus a phase jump at the chirp wrap).
  The gated loop cannot follow it at low SNR. Balanced lost the same way, but less (−12.0 →
  −12.2 dB).
- **Open-loop integral after sparse loop updates: part of the same drift,** visible per packet
  (ramps of 0.5 chip with ε correct to 3 ppm). It is fixed by the 1/g scaling, with no PER
  change of its own in AWGN once ε is accurate.
- **Soft-metric scaling: 0 dB.** The mean(peak − 1) Es estimate is 2–20% high near the limit,
  but oracle Es gives identical PER: ln I0 is nearly linear in |X| there, so its scale barely
  matters.
- **2 ms glide at SF8: ≤ 0.05 dB** (genie SER 20.6% vs 20.2% without it at −15 dB).
- **Preamble/header: ≈ 0.3 dB, remaining.** After the fix ([`loss.md`](../sim/results/loss.md),
  100 packets per point), 90% of long-range packets sync at −14.8 dB and pass the header at
  −14.5 dB. The genie-timed payload limit is also −14.5 dB, so sync and header now co-limit, and
  the full modem reaches −14.2 dB. Most header losses near −15 dB are the consistency check
  (≥ 5 of 8 header chirps at the decoded codeword, D-011) on a correct sync. Relaxing that check
  would gain < 0.1 dB at the cost of false-header protection, so it stays. Further gains need a
  longer preamble or header (D-008), not receiver changes.

Result, against the final pre-fix sweep: long-range −12.7 → −14.2 dB (PER ≤ 10%) and −11.3 →
−13.3 dB (≤ 1%) in AWGN, and −8.3 → −10.8 dB in the far room
([`modem.md`](../sim/results/modem.md)). Balanced gains about 1 dB as well. Long-range is now
2.0 dB (AWGN) to 2.7 dB (far room) more sensitive than balanced. Hand-held sway performance is
unchanged.

**Limit.** Long-range's 197 ms symbols cannot follow sway of ±0.1 m/s every 2 s: the velocity
changes within one symbol. Balanced and fast decode under that sway at about 0 dB (`modem.md`,
hand-held column; fast's 1.7 dB cell differs from the pre-fix −0.0 dB by one packet of 30 at
2 dB). Long-range needs the devices roughly at rest.

### D-013 Payload FEC: K=7 rate-½ convolutional, soft Viterbi, bit-interleaved (BICM) — *sim*

**Evidence.** [`sim/results/fec.md`](../sim/results/fec.md): CSS with genie timing (SF7 unless
noted), 32-byte payloads, 100 packets per point. Cells are the SNR (dB) for PER ≤ 10%:

| Scheme | rate | AWGN | far room |
|---|---|---|---|
| uncoded + CRC | 1 | −8.8 | −3.2 |
| Hamming(7,4) soft ML + interleaver | 0.57 | −10.3 | −4.4 |
| RS shortened n = 2k (hard, errors-only) | 0.5 | −11.2 | −5.4 |
| K=7 conv ½, soft Viterbi, **no** interleaver | 0.5 | −10.5 | −4.0 |
| **K=7 conv ½, soft Viterbi + interleaver** | 0.5 | **−12.1** | **−7.1** |
| K=7 conv ⅔ (punctured) + interleaver | 0.67 | −11.2 | −6.3 |
| K=7 conv ½ + interleaver, **SF8** (the long-range payload) | 0.5 | −14.8 | n/a¹ |

¹ The genie candidate demodulator compensates neither timing drift nor carrier offset. The
far-room condition carries a 50 ppm clock offset: ≈ 0.85 chip of drift over the 13 s SF8 block,
plus 0.9 Hz. SF7 tolerates that, SF8 does not (checked: 30/30 packets at −10 dB without the clock
offset, 11/30 at −6 dB with it). So this cell measures the candidate, not the code. `loss.md` has
the SF8 far-room payload limit with the true time scale: −11.1 dB.

SF8 is 2.7 dB better than SF7 with the same code, as expected from twice the symbol energy at
one more bit per symbol. The full long-range modem reaches −14.2 dB, 0.6 dB from this row:
0.3 dB is the frame (CRC-16 and tail bits, the receiver's per-symbol normalisation, see
`loss.md` genie −14.5 dB) and 0.3 dB is sync and header (D-012).

Soft decisions over non-coherent M-ary metrics, combined with interleaving, win by 0.9 dB over RS
in AWGN and by 1.7 dB in reverb. RS works on hard byte decisions. One wrong chirp corrupts 1–2
bytes, but reverb produces bursts that exceed its correction capability.

The interleaver alone is worth 1.6 dB (AWGN) to 3.1 dB (far room). This is the measured case for
D-019.

The punctured ⅔ code costs about 0.9 dB for 33% more throughput, so it is used only by the fast
profile, where speed is the point.

**Rejected.**
- RS as the inner code.
- Hamming / LoRa-style codes.
- An outer RS on top of the conv code: the per-packet CRC plus the rateless erasure code across
  packets (D-016) already turn residual errors into erasures, which is the efficient way to use
  extra redundancy here.

### D-014 Profiles — *sim* ([`sim/results/modem.md`](../sim/results/modem.md))

| Profile | Payload | Net bit/s | PER ≤ 10%: AWGN / far room / hand-held | Why |
|---|---|---|---|---|
| long-range | SF8, r=½ | 20 | −14.2 / −10.8 / — dB | The most robust setting that keeps a short message near the ≈10 s soft ceiling (11 s). SF9 would gain about 2.5–3 dB but double the air time. |
| balanced | SF7, r=½ | 36 | −12.2 / −8.1 / ≈ 0 dB | 2.0–2.7 dB less sensitive than long-range, 1.75× faster, and tolerates hand-held sway. |
| fast | SF5, r=⅔ | 135 | −5.0 / +2.5 / ≈ 0 dB | About 4× faster than balanced, for close range. Short symbols tolerate motion; long reverb hurts it. |

The preamble and header are identical for all profiles, at SF8, so any receiver decodes any
profile without configuration.

### D-015 Packet size caps per profile: 32 / 64 / 192 bytes — *analysis*

Keep a packet near 15 s or less on air. A lost packet then costs little, the carousel re-sends
quickly, and timing drift or motion within one packet stays within what the tracking loop
handles. Long-range: 32 B → 70 SF8 symbols ≈ 13.8 s. Balanced: 64 B ≈ 15 s. Fast: 192 B ≈ 11 s.
The PHY length field allows 1–256 B, so the caps can be raised once bench data shows long
packets survive.

### D-016 Multi-packet: systematic rateless erasure code over GF(256) — *analysis, tested*

**Decision.** Fragments 0…k−1 are the data. Fragment indices ≥ k are random GF(256)
combinations whose coefficients come from (message id, index). Any k independent fragments
decode, in any order, with duplicates ignored.

**Why.** It fits broadcast with no back-channel (user decision). A sender can run a carousel of
fresh repair fragments, and each one helps every receiver whatever it lost. A late joiner
finishes after any k receptions.

**Rejected.**
- RS over fragments: n ≤ 255, fixed in advance.
- Plain repetition: each copy helps only receivers that lost exactly that fragment.
- ARQ-only: it needs a back-channel, which iOS makes awkward and broadcast makes impossible.

### D-017 Text codec: static order-1 arithmetic coding + small dictionary, UTF-8 fallback — *measured on held-out text*

**Evidence.** [`protocol/text/results.md`](../protocol/text/results.md) gives bits per char:

| Codec | bits/char |
|---|---|
| UTF-8 | 8.2 |
| 6-bit alphabet | 6.8 |
| static Huffman | 5.7 |
| order-1 arithmetic | 4.9 |
| + dictionary (chosen) | 4.7 |
| sender's best-of (compact vs UTF-8 per message) | 4.5 |

On chat-style messages the chosen codec reaches 3.6 bits/char. The model is built from a 7 KB
original corpus at load time with integer quantisation, so every device derives an identical
table (tested).

**Rejected.**
- smaz/shoco-style pure dictionaries: dominated by order-1 at these lengths.
- unishox2: similar idea, larger tables, and gains mostly on longer text.
- A non-Latin script mode: the sender simply picks UTF-8 for such messages (8.5 vs 11 bits/char
  for compact).

### D-018 Protocol frame layout — *analysis*

- A single-packet message costs an 8-bit header.
- A fragment costs 12 bits plus two Exp-Golomb integers (14–30 bits).
- Control frames cost 11 bits plus an optional count.
- The `11` frame type is the version escape.

Rationale per field: [PROTOCOL.md](PROTOCOL.md).

### D-019 Interleaving: pseudo-random bit permutation per block length — *sim*

Reverb smears energy into neighbouring symbols, and clicks wipe out a few consecutive symbols.
Both produce bursts at the symbol level. A fixed pseudo-random permutation (seeded by the block
length, so it is never signalled) spreads each burst across the codeword. Measured benefit:
[`sim/results/fec.md`](../sim/results/fec.md), "no interleaver" row.

### D-020 Sync search covers ±2 m/s; coarse-to-fine — *sim*

±2 m/s (a brisk walk towards the other device, about ±100 Hz) bounds the carrier hypotheses. A
coarse pass reads the carrier from the summed down-chirp spectrum per boundary candidate, twice,
the second time on the time scale implied by the first estimate. An exact aligned search then
runs only around it. That is about 100× fewer FFTs than exhaustive scoring, with identical
low-SNR results (checked) and exact estimates from −1.5 to +1.9 m/s (0.1 Hz, a few µs).

### D-021 Receiver on the main thread; AudioWorklet only captures — *analysis*

The receiver costs 0.7% of real time in Node (60 s of audio in 0.4 s). A worklet-hosted
receiver would complicate the code: no module imports in older WebKit worklets, and transfer of
results. The capture worklet only forwards blocks. If phones show UI jank, the receiver moves to
a Web Worker unchanged, since it is a pure class.

### D-022 Tooling and hosting — *user decision*

Plain TypeScript, Vite (multi-page static build), Vitest, tsx for the simulator. No frameworks.
GitHub Actions runs typecheck, tests, the quick simulator sweep and the build, and deploys to
GitHub Pages from `main` (HTTPS for phones with no certificates to install).

### D-023 Bench markers — *sim*

The two-device tests start with a 0.25 s 17.1→18.4 kHz chirp matched filter, normalised by
local energy. Its threshold |ρ|² ≥ 0.1 is about 30× the noise mean of 1/(T·B), and it detects
down to about −10 dB in-band. The BER mode needs to reach −17 dB and to be immune to the timing
error a linear chirp turns clock offset into, so it uses a 1 s up-then-down (V) chirp whose two
halves cancel that error (±13 µs at 40 ppm).
