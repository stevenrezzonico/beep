Estimator accuracy from the modem study (32-byte packets, mean over decoded packets).

- **Velocity column.** The conditions with a 50 ppm clock offset (all except awgn) show a
  constant 0.033 m/s. That is twice the clock term (343 m/s × 50 ppm = 0.017 m/s), because the
  study's *reference* added the clock term with the wrong sign (fixed in `sim/jobs.ts` after this
  run). The estimator itself is accurate to 0.001–0.004 m/s, as the awgn rows without clock
  offset show.
- **SNR column.** In AWGN the estimate is within about 1 dB. In the rooms it is lower than the
  direct-path SNR because reverberant energy counts as interference, so it reports the
  signal-to-noise-plus-reverb ratio that actually limits decoding.

| Profile | cond | true SNR | mean estimated SNR | mean |v| error (m/s) |
|---|---|---|---|---|
| long-range | awgn | 12 | 11.0 | 0.001 |
| long-range | awgn | 6 | 5.5 | 0.001 |
| long-range | awgn | 0 | -0.3 | 0.001 |
| long-range | awgn | -6 | -6.3 | 0.003 |
| long-range | awgn | -12 | -12.5 | 0.004 |
| long-range | room-near | 12 | 3.2 | 0.033 |
| long-range | room-near | 6 | 0.5 | 0.034 |
| long-range | room-near | 0 | -4.1 | 0.034 |
| long-range | room-near | -6 | -9.6 | 0.033 |
| long-range | room-near | -12 | -15.3 | 0.034 |
| long-range | room-far | 12 | -4.3 | 0.034 |
| long-range | room-far | 6 | -5.0 | 0.033 |
| long-range | room-far | 0 | -6.8 | 0.033 |
| long-range | room-far | -6 | -10.6 | 0.032 |
| long-range | doppler | 12 | 10.9 | 0.033 |
| long-range | doppler | 6 | 5.5 | 0.034 |
| long-range | doppler | 0 | -0.4 | 0.034 |
| long-range | doppler | -6 | -6.3 | 0.033 |
| long-range | doppler | -12 | -12.6 | 0.036 |
| long-range | hand-held | 12 | 1.6 | 0.005 |
| long-range | hand-held | 6 | -0.0 | 0.005 |
| long-range | hand-held | 0 | -3.4 | 0.004 |
| balanced | awgn | 12 | 10.5 | 0.001 |
| balanced | awgn | 6 | 5.4 | 0.002 |
| balanced | awgn | 0 | -0.4 | 0.001 |
| balanced | awgn | -6 | -6.3 | 0.003 |
| balanced | awgn | -12 | -12.2 | 0.004 |
| balanced | room-near | 12 | 3.2 | 0.034 |
| balanced | room-near | 6 | 0.5 | 0.033 |
| balanced | room-near | 0 | -4.1 | 0.034 |
| balanced | room-near | -6 | -9.9 | 0.034 |
| balanced | room-far | 12 | -4.4 | 0.034 |
| balanced | room-far | 6 | -5.0 | 0.034 |
| balanced | room-far | 0 | -6.9 | 0.034 |
| balanced | room-far | -6 | -10.8 | 0.034 |
| balanced | doppler | 12 | 10.3 | 0.033 |
| balanced | doppler | 6 | 5.3 | 0.033 |
| balanced | doppler | 0 | -0.4 | 0.034 |
| balanced | doppler | -6 | -6.4 | 0.034 |
| balanced | doppler | -12 | -12.2 | 0.034 |
| balanced | hand-held | 12 | 2.2 | 0.005 |
| balanced | hand-held | 6 | 0.6 | 0.006 |
| balanced | hand-held | 0 | -2.9 | 0.005 |
| balanced | hand-held | -6 | -8.2 | 0.006 |
| fast | awgn | 12 | 8.6 | 0.001 |
| fast | awgn | 6 | 4.6 | 0.002 |
| fast | awgn | 0 | -0.7 | 0.002 |
| fast | awgn | -6 | -6.3 | 0.002 |
| fast | room-near | 12 | 2.6 | 0.034 |
| fast | room-near | 6 | 0.0 | 0.034 |
| fast | room-near | 0 | -4.4 | 0.034 |
| fast | room-far | 12 | -4.6 | 0.034 |
| fast | room-far | 6 | -5.3 | 0.035 |
| fast | room-far | 0 | -6.9 | 0.034 |
| fast | doppler | 12 | 8.5 | 0.034 |
| fast | doppler | 6 | 4.5 | 0.033 |
| fast | doppler | 0 | -0.9 | 0.034 |
| fast | doppler | -6 | -6.4 | 0.035 |
| fast | hand-held | 12 | 2.4 | 0.006 |
| fast | hand-held | 6 | 0.8 | 0.006 |
| fast | hand-held | 0 | -2.8 | 0.007 |
| fast | hand-held | -6 | -6.8 | 0.005 |
