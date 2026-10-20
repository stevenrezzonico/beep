Payload FEC comparison on SF7 CSS with genie timing (32-byte payloads). Cells: SNR (dB) for PER ≤ 10% / ≤ 1%, and the code rate.

| Scheme | rate | awgn | room-far |
|---|---|---|---|
| uncoded (CRC only) | 1.00 | -8.8 / -7.3 | -3.2 / -2.0 |
| Hamming(7,4) soft ML + interleaver | 0.57 | -10.3 / -9.5 | -4.4 / -3.0 |
| RS shortened, n=2k (hard, errors-only) | 0.50 | -11.2 / -11.0 | -5.4 / -4.5 |
| K=7 conv r=1/2 soft Viterbi, no interleaver | 0.50 | -10.5 / -9.3 | -4.0 / -1.0 |
| K=7 conv r=1/2 soft Viterbi + interleaver | 0.50 | -12.1 / -11.3 | -7.1 / -6.3 |
| K=7 conv r=2/3 (punctured) + interleaver | 0.67 | -11.2 / -11.0 | -6.3 / -5.0 |
