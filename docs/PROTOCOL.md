# beep protocol, version 1

Bit economy drives every choice. The long-range profile moves about 20 net bit/s, so each header
bit costs about 50 ms of air time. A field earns its place only if a receiver needs it.

```
packet = [preamble][PHY header][PHY payload]
            SF8       SF8      profile SF, K=7 conv code, CRC-16
                                └─ protocol frame (this document, §3–§6)
```

## 1. Preamble (identical for all profiles)

| Part | Chirps | Purpose |
|---|---|---|
| Up-chirps, value 0 | 8 | Detection (CFAR, D-009) and Δ−d: carrier offset minus timing |
| Down-chirps | 4 | Δ+d, so carrier offset and symbol boundary separate (D-008, D-012) |

All chirps are SF8 over 17.1–18.4 kHz (256 chips, 197 ms). The current values of nUp, nDown and
nHeader are in `modem/profiles.ts` and come from
[`sim/results/preamble.md`](../sim/results/preamble.md). There is no sync word: the protocol has
a single network, and the header code plus the CRC-16 reject foreign or false packets.

## 2. PHY header (identical for all profiles, sent at SF8)

| Field | Bits | Meaning | Rationale |
|---|---|---|---|
| profile | 2 | 0 long-range, 1 balanced, 2 fast, 3 reserved | The receiver must know the payload SF and code before it can demodulate the payload. |
| length | 8 | payload bytes − 1 (1…256) | Needed to know how many symbols to collect. One byte covers the per-profile caps (32/64/192) with headroom. |
| rsv | 2 | 0 in v1 | Version escape at zero cost to v1 senders. A v1 receiver rejects non-zero values. |

These 12 bits form two GF(256) symbols of a **Reed–Solomon (8, 2)** codeword, one symbol per
chirp (bin = v·2^(SF−8)), 8 chirps in total. They are decoded by **soft maximum likelihood over
all 4,096 headers and a common bin offset of ±2** (carrier drift since the preamble). A header
is accepted only if its evidence beats the noise maximum at false-accept 10⁻⁴ and at least 5 of
the 8 chirps peak at (±1 bin of) the codeword (D-011).

There is no header CRC. The ML acceptance test plays that role, and the payload CRC-16 covers
the header fields too. A false header therefore costs a wasted payload decode, never a corrupt
packet.

Everything else (message type, ids, fragment numbers) travels in the payload, where bits are
cheaper: balanced and fast are 1.75–5× faster than the header's SF8.

## 3. PHY payload coding (per profile)

```
data (L bytes) ‖ CRC-16/CCITT (over header fields ‖ data)
  → K=7 convolutional code (171,133), rate ½ (long-range, balanced) or punctured ⅔ (fast), 6-bit zero tail
  → pseudo-random bit interleaver (seeded by block length)
  → SF-bit groups → Gray map → chirp shifts
```

The FEC choice is [D-013](DECISIONS.md) with data in
[`sim/results/fec.md`](../sim/results/fec.md). CRC-16 has Hamming distance 4 up to 32,767 bits,
far beyond the 2,064-bit maximum here. Its undetected-error probability for a corrupted block is
2⁻¹⁶. The receiver also tries whole-bin shifts ±1 when decoding fails (D-012), which makes the
bound 3·2⁻¹⁶. No silent corruption has been observed in any simulation (the `corrupt` column of
[`sim/results/modem.md`](../sim/results/modem.md)).

## 4. Protocol frame (the PHY payload)

Bit-packed, MSB first. Bit-oriented content is terminated by **"1 then 0s" padding** to the byte
boundary. The receiver strips trailing zeros and the final 1, so no length field is needed (cost:
1–8 bits, mean 4.5).

| Type (2 bits) | Layout after the type | Size of header |
|---|---|---|
| `00` single | ctype:2 · ack:1 · id:3 · content… | **8 bits** |
| `01` fragment | ctype:2 · ack:1 · id:7 · EG(k−1) · EG(index) · fragment bytes… | 12 bits + 2 Exp-Golomb (≈14–30) |
| `10` control | kind:2 · id:7 · [EG(n)] | 11 bits (+ n) |
| `11` extended | EG(version − 2) · … | v1 receivers report "unsupported version" and drop |

The fields and why each is the size it is:

- **type (2).** Four kinds of frame. The fourth is the extension escape, which costs nothing in
  the common case.
- **ctype (2): content type.**
  - 0: compact text (§6).
  - 1: UTF-8 text.
  - 2: raw bytes.
  - 3: typed, where EG(subtype) follows. Subtype 0 is a file: the name in compact text, then the
    bytes.

  The sender picks the smallest representation.
- **ack (1).** The sender asks for an ACK/NEED reply (1:1 mode only, D-006). Broadcast senders
  leave it 0.
- **id.**
  - 3 bits for single frames. That is enough to tell repeats of the same message within a
    session, and duplicates are also matched on content.
  - 7 bits for fragments. Concurrent multi-packet messages must not collide; 128 ids with a
    random start per sender make a collision between two simultaneous senders 1/128. A collision
    is still caught by the message CRC-32 (§5).
- **EG(k−1), EG(index).** Order-0 Exp-Golomb, so small counts (the common case) cost 1–7 bits
  and there is no upper limit. For example k = 22 (4 KB on fast) costs 9 bits, and index 0–6
  costs 1–5 bits.

## 5. Multi-packet messages (fragmentation, reassembly)

**Envelope.** `LEB128(content length) ‖ content ‖ CRC-32`, split into k equal fragments of F
bytes. The last fragment is zero-padded. F is the largest size that keeps
header + F + 1 pad bit ≤ the profile's packet cap (D-015). The length prefix is paid once per
message instead of once per fragment. The CRC-32 catches a reassembly that mixed fragments of two
messages whose ids collided.

**Erasure code (D-016).** Index i < k sends source fragment i. Index i ≥ k sends a repair
fragment: Σ c_j·src_j over GF(256), with coefficients c_j pseudo-random and derived from
(id, k, i), so they are never transmitted. Any k independent fragments recover the message: k
fragments succeed with probability ≈ 99.6%, k+1 with ≈ 99.998%.

**Sender policy.**
- *Broadcast (default):* k sources plus ⌈0.25·k⌉ repairs, at least 1. Optionally "keep
  repeating", which continues with fresh repair indices until stopped (a carousel).
- *1:1 with back-channel:* send k, read the receiver's `NEED n`, then send n fresh repairs.

**Receiver (`Reassembler`).**

- **Out-of-order:** fragments of a message are matched on (id, k, F, ctype). Order is irrelevant.
- **Duplicates:** a repeated index is counted and dropped. Repeats of a completed message are
  reported as duplicates and not delivered again (remembered for 15 min, at most 256 entries).
- **Missing-fragment reporting:**
  - Progress events give rank/k, received, duplicates, and which source fragments have not been
    seen directly.
  - With a rateless code the only actionable number is **k − rank**: *any* that many new
    fragments complete the message. That is what `NEED n` carries.
- **Bounded buffer:**
  - at most 8 partial messages and 512 KB of buffered fragment data, with least-recently-active
    eviction;
  - k ≤ 4096;
  - partial messages idle for 15 min are dropped.
- **Failure:** CRC-32 or length mismatch after decoding discards the message and says so.
  Nothing corrupt is ever delivered.

## 6. Text encoding

See [D-017](DECISIONS.md) and [`protocol/text/results.md`](../protocol/text/results.md). These
are held-out measurements on 40 realistic messages (chat, Wi-Fi credentials, codes, URLs,
contacts, addresses, notes, prose, other languages, emoji):

| Codec | bits/char (all) | chat | URL | prose |
|---|---|---|---|---|
| UTF-8 | 8.21 | 8.00 | 8.00 | 8.00 |
| 6-bit alphabet + shift/escape | 6.79 | 6.34 | 6.17 | 6.14 |
| static Huffman (order 0) | 5.70 | 4.89 | 5.63 | 4.57 |
| order-1 arithmetic | 4.91 | 3.78 | 5.36 | 3.53 |
| **order-1 arithmetic + dictionary (v1 "compact")** | **4.69** | **3.61** | **4.02** | **3.37** |
| best of compact / UTF-8 (sender rule) | 4.48 | 3.61 | 4.02 | 3.37 |

**Compact text, format.**
- Alphabet: 95 printable ASCII characters, newline, ESC, EOS, and 12 dictionary tokens
  (`https://`, `http://`, `www.`, `.com`, `.org`, `.net`, `the `, `ing`, `and `, `you`,
  `tion`, ` the`).
- Model: an order-1 model (previous symbol as context) interpolated with order-0 (β = 8),
  trained on `protocol/text/corpus.ts` and quantised to 16-bit integer frequencies at load time,
  identically on every device.
- Coding: a 32-bit binary arithmetic coder.
- ESC is followed by the code point as Exp-Golomb(cp − 128) in equiprobable bits.
- EOS terminates, so trailing padding is harmless.

**Model versioning.** The model is part of the protocol version. Changing the corpus, the
dictionary or β requires a new content type or protocol version, never a silent change.

## 7. Throughput and air time

Computed by `npx tsx protocol/report.ts` into [`protocol/report.md`](../protocol/report.md). It
includes the preamble, header and payload coding, and 25% repair fragments for multi-packet
messages.

Preamble 8↑+4↓ SF8 = 2.36 s, header 8 chirps = 1.58 s per packet.

| Message | profile | content bits | packets (k + repair) | air time (s) | effective bit/s |
|---|---|---|---|---|---|
| chat: "On my way, be there in 15 min" | long-range | 104 | 1 | 11.0 | 21.0 |
| chat: "On my way, be there in 15 min" | balanced | 104 | 1 | 8.0 | 29.1 |
| chat: "On my way, be there in 15 min" | fast | 104 | 1 | 5.0 | 46.4 |
| Wi-Fi: "WiFi: Guest-Net-2.4 / pass: blueberry77" | long-range | 232 | 1 | 17.3 | 18.0 |
| Wi-Fi: "WiFi: Guest-Net-2.4 / pass: blueberry77" | balanced | 232 | 1 | 11.6 | 26.9 |
| Wi-Fi: "WiFi: Guest-Net-2.4 / pass: blueberry77" | fast | 232 | 1 | 5.9 | 52.6 |
| URL: "https://example.com/r/8fK2" | long-range | 117 | 1 | 11.4 | 18.2 |
| URL: "https://example.com/r/8fK2" | balanced | 117 | 1 | 8.2 | 25.5 |
| URL: "https://example.com/r/8fK2" | fast | 117 | 1 | 5.0 | 41.2 |
| 280-char paragraph | long-range | 919 | 5 + 2 | 121.3 | 17.8 |
| 280-char paragraph | balanced | 919 | 2 + 1 | 57.0 | 37.9 |
| 280-char paragraph | fast | 919 | 1 | 11.0 | 197.2 |
| 1 KB binary file | long-range | 8248 | 39 + 10 | 862.5 | 9.5 |
| 1 KB binary file | balanced | 8248 | 18 + 5 | 432.2 | 19.0 |
| 1 KB binary file | fast | 8248 | 6 + 2 | 123.2 | 66.5 |
| 4 KB binary file | long-range | 32824 | 159 + 40 | 3500.9 | 9.4 |
| 4 KB binary file | balanced | 32824 | 70 + 18 | 1670.9 | 19.6 |
| 4 KB binary file | fast | 32824 | 22 + 6 | 430.7 | 76.1 |

A short message takes 5 s (fast) to 11 s (long-range), which meets the ≈10 s soft ceiling except
for long-range, which is about 1 s over. The fixed cost is the preamble and header: 3.9 s per
packet, the price of decoding them at −14 dB. Kilobyte files take minutes: a 4 KB file is about
7 min on fast and about 1 h on long-range. This is the honest throughput of ~1.3 kHz with
non-coherent signalling robust enough for rooms.

## 8. Extensibility and versioning rules

1. **v1 senders pay zero bits for versioning.** Future versions use the header's `rsv` bits
   (PHY) or the `11` frame type (protocol).
2. **A v1 receiver must reject** `rsv ≠ 0`, profile 3, frame type `11` and typed-content
   subtypes ≠ 0, and report them as "unsupported/newer version". It must never guess.
3. **New content types** come in through the typed subtype (Exp-Golomb, unlimited).
4. **New profiles** need PHY profile value 3 plus a version bump, because the header field is
   only 2 bits. This is deliberate: three profiles cover the distance/speed range in 1.3 kHz.
5. **The text model** (corpus, dictionary, β) is frozen per version (§6).
