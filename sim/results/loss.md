Where 32-byte packets are lost. Full receiver stages (sync, header, decoded packet) and a genie-timed decode of the same payload samples (true timing, time scale and carrier; the receiver's own normalisation, soft metric and Viterbi). Cells: SNR (dB) where ≥ 90% of packets pass that stage.

| Profile | cond | sync | header | full modem (PER ≤ 10%) | genie payload (PER ≤ 10%) | implementation loss (dB) |
|---|---|---|---|---|---|---|
| long-range | awgn | -14.8 | -14.5 | -14.2 | -14.5 | 0.3 |
| balanced | awgn | -15.2 | -14.8 | -12.1 | -12.1 | 0.0 |
| long-range | room-far | -11.2 | -11.1 | -10.9 | -11.1 | 0.2 |
| balanced | room-far | -11.3 | -11.1 | -8.1 | -8.1 | 0.0 |

| Profile | cond | SNR | sent | synced | header OK | packet OK | genie payload OK |
|---|---|---|---|---|---|---|---|
| long-range | awgn | -10 | 100 | 100 | 100 | 100 | 100 |
| long-range | awgn | -11 | 100 | 100 | 100 | 100 | 100 |
| long-range | awgn | -12 | 100 | 100 | 100 | 100 | 100 |
| long-range | awgn | -13 | 100 | 99 | 99 | 99 | 100 |
| long-range | awgn | -14 | 100 | 99 | 98 | 98 | 100 |
| long-range | awgn | -15 | 100 | 88 | 83 | 60 | 79 |
| long-range | awgn | -16 | 100 | 58 | 37 | 2 | 7 |
| long-range | awgn | -17 | 100 | 25 | 9 | 0 | 0 |
| long-range | awgn | -18 | 100 | 11 | 2 | 0 | 0 |
| balanced | awgn | -8 | 100 | 100 | 100 | 100 | 100 |
| balanced | awgn | -9 | 100 | 100 | 100 | 100 | 100 |
| balanced | awgn | -10 | 100 | 100 | 100 | 100 | 100 |
| balanced | awgn | -11 | 100 | 100 | 100 | 98 | 100 |
| balanced | awgn | -12 | 100 | 100 | 100 | 96 | 96 |
| balanced | awgn | -13 | 100 | 100 | 100 | 35 | 37 |
| balanced | awgn | -14 | 100 | 99 | 98 | 0 | 0 |
| balanced | awgn | -15 | 100 | 94 | 88 | 0 | 0 |
| balanced | awgn | -16 | 100 | 68 | 48 | 0 | 0 |
| long-range | room-far | -5 | 100 | 100 | 100 | 100 | 100 |
| long-range | room-far | -6 | 100 | 100 | 100 | 100 | 100 |
| long-range | room-far | -7 | 100 | 100 | 100 | 100 | 100 |
| long-range | room-far | -8 | 100 | 100 | 100 | 100 | 100 |
| long-range | room-far | -9 | 100 | 100 | 100 | 100 | 100 |
| long-range | room-far | -10 | 100 | 100 | 100 | 100 | 100 |
| long-range | room-far | -11 | 100 | 95 | 92 | 89 | 99 |
| long-range | room-far | -12 | 100 | 71 | 58 | 13 | 37 |
| long-range | room-far | -13 | 100 | 50 | 19 | 0 | 0 |
| balanced | room-far | -4 | 100 | 100 | 100 | 100 | 100 |
| balanced | room-far | -5 | 100 | 100 | 100 | 100 | 100 |
| balanced | room-far | -6 | 100 | 100 | 100 | 100 | 100 |
| balanced | room-far | -7 | 100 | 100 | 100 | 97 | 100 |
| balanced | room-far | -8 | 100 | 100 | 100 | 95 | 96 |
| balanced | room-far | -9 | 100 | 100 | 100 | 43 | 51 |
| balanced | room-far | -10 | 100 | 99 | 99 | 5 | 4 |
| balanced | room-far | -11 | 100 | 97 | 94 | 0 | 0 |
| balanced | room-far | -12 | 100 | 75 | 54 | 0 | 0 |
