Uncoded BER: SNR (dB, peak-referenced, 1.5 kHz band) needed for BER 1e-2 / 1e-3. "floor" = never reached in the sweep.

| Candidate | Raw bit/s | Const. env. | PAPR dB | Leak dBc <16.9k / <16k / <16.9k after k3 | awgn @1e-2 / 1e-3 | room-near @1e-2 / 1e-3 | room-far @1e-2 / 1e-3 | doppler @1e-2 / 1e-3 | hand-held @1e-2 / 1e-3 | motion-room @1e-2 / 1e-3 |
|---|---|---|---|---|---|---|---|---|---|---|
| OOK T=10 ms | 100.0 | no | 4.3 | -52 / -69 / -53 | 5.4 / 7.2 | floor / floor | floor / floor | 6.0 / 7.5 | floor / floor | floor / floor |
| BFSK T=10.0 ms Δf=100.0 Hz | 100.0 | yes | 3.0 | -52 / -62 / -52 | -2.9 / -0.3 | 5.1 / 13.6 | floor / floor | 0.3 / 4.3 | 2.4 / 22.5 | 3.1 / 28.7 |
| 32-FSK T=24.6 ms Δf=40.6 Hz | 203.1 | yes | 3.0 | -35 / -47 / -35 | -4.9 / -3.3 | 1.5 / 23.2 | floor / floor | floor / floor | -3.1 / 4.7 | -0.3 / 27.2 |
| 16-FSK T=24.6 ms Δf=81.3 Hz | 162.5 | yes | 3.0 | -35 / -47 / -35 | -5.5 / -4.1 | 1.0 / 9.2 | floor / floor | 1.9 / 3.9 | -2.5 / 4.8 | -2.3 / 10.8 |
| 16-FSK T=24.6 ms Δf=40.6 Hz hop×2 | 162.5 | yes | 3.0 | -34 / -47 / -34 | -5.0 / -3.7 | 0.4 / 3.1 | floor / floor | 1.7 / 3.8 | -3.7 / -2.0 | -2.5 / 4.0 |
| 32-FSK T=24.6 ms Δf=40.6 Hz guard 10 ms | 144.4 | yes | 3.0 | -37 / -49 / -37 | -4.8 / -3.8 | 2.2 / 21.2 | floor / floor | floor / floor | -1.8 / 26.2 | 0.8 / 25.4 |
| 128-FSK T=98.5 ms Δf=10.2 Hz | 71.1 | yes | 3.0 | -44 / -54 / -44 | -10.3 / -9.6 | -3.8 / 16.0 | floor / floor | floor / floor | 0.1 / floor | floor / floor |
| GMSK 1000 b/s BT=0.5 | 1000.0 | yes | 3.0 | -35 / -72 / -35 | 7.7 / 10.3 | floor / floor | floor / floor | floor / floor | floor / floor | floor / floor |
| DBPSK 800 Bd RRC β=0.5 | 800.0 | no | 6.4 | -58 / -63 / -49 | 6.5 / 8.1 | 20.2 / floor | floor / floor | floor / floor | 19.9 / floor | floor / floor |
| DSSS L=31 @ 800 chip/s (DBPSK) | 25.8 | no | 6.2 | -58 / -63 / -49 | -8.1 / -6.0 | -5.1 / -3.8 | -4.5 / -1.7 | 18.3 / 20.1 | 29.4 / floor | floor / floor |
| D-OFDM 32 carriers, T=24.6+10 ms CP | 898.5 | no | 13.4 | -33 / -60 / -33 | 21.9 / 24.7 | floor / floor | floor / floor | floor / floor | floor / floor | floor / floor |
| CSS SF5 (24.6 ms) | 203.1 | yes | 3.0 | -25 / -39 / -25 | -4.4 / -2.5 | -0.5 / 0.3 | 6.3 / floor | floor / floor | -3.7 / -2.4 | floor / floor |
| CSS SF6 (49.2 ms) | 121.9 | yes | 3.0 | -29 / -41 / -29 | -7.2 / -5.9 | -3.6 / -2.0 | -2.0 / 0.2 | floor / floor | -6.3 / -4.9 | floor / floor |
| CSS SF7 (98.5 ms) | 71.1 | yes | 3.0 | -32 / -45 / -32 | -10.1 / -9.6 | -6.6 / -5.7 | -5.8 / -4.5 | floor / floor | -5.3 / 15.2 | floor / floor |
| CSS SF8 (196.9 ms) | 40.6 | yes | 3.0 | -34 / -47 / -34 | -12.5 / -11.7 | -9.3 / -7.9 | -8.0 / -7.6 | floor / floor | floor / floor | floor / floor |
| CSS SF9 (393.8 ms) | 22.9 | yes | 3.0 | -37 / -50 / -37 | -15.8 / -15.5 | -10.4 / 24.2 | -9.7 / 28.2 | floor / floor | floor / floor | floor / floor |
