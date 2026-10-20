Bits per character on 40 held-out messages (1714 chars). Lower is better.

| Codec | all | chat | wifi | code | url | contact | address | note | event | prose | intl | emoji | mixed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| UTF-8 | **8.21** | 8.00 | 8.00 | 8.00 | 8.00 | 8.00 | 8.00 | 8.00 | 8.00 | 8.00 | 10.17 | 11.00 | 8.41 |
| 6-bit alphabet + shift/escape | **6.79** | 6.34 | 7.00 | 6.47 | 6.17 | 6.28 | 6.84 | 6.27 | 6.27 | 6.14 | 11.07 | 10.78 | 7.12 |
| static Huffman order-0 | **5.70** | 4.89 | 6.18 | 5.95 | 5.63 | 5.91 | 5.43 | 4.82 | 4.98 | 4.57 | 11.15 | 9.81 | 6.54 |
| order-1 arithmetic, no dictionary | **4.91** | 3.78 | 6.32 | 4.70 | 5.36 | 5.15 | 4.66 | 4.30 | 3.75 | 3.53 | 10.99 | 8.75 | 6.05 |
| order-1 arithmetic + dictionary (chosen) | **4.69** | 3.61 | 6.24 | 4.61 | 4.02 | 4.87 | 4.45 | 4.21 | 3.64 | 3.37 | 10.99 | 8.38 | 5.97 |
| best of {compact, UTF-8} (what the sender does) | **4.48** | 3.61 | 6.24 | 4.61 | 4.02 | 4.87 | 4.45 | 4.21 | 3.64 | 3.37 | 8.51 | 8.38 | 5.97 |

Interpolation weight β (order-1 vs order-0), mean bits/char on the held-out messages:

| β | bits/char |
|---|---|
| 1 | 4.781 |
| 2 | 4.742 |
| 4 | 4.705 |
| 6 | 4.688 |
| 8 | 4.684 |
| 12 | 4.681 |
| 16 | 4.676 |
| 32 | 4.699 |

Corpus: 110 lines. Examples:

| Message | chars | UTF-8 bits | compact bits |
|---|---|---|---|
| On my way, be there in 15 min | 29 | 232 | 104 |
| Thanks!! That was so kind of you :) | 35 | 280 | 154 |
| Good night, talk tomorrow. | 26 | 208 | 101 |
| network Lab-5G password Xq7#mP2v | 32 | 256 | 206 |
| https://example.com/r/8fK2 | 26 | 208 | 118 |
| Call me on 555 0147 or email sam@example.org | 44 | 352 | 165 |
| Pay rent, renew passport, book dentist appointment | 50 | 400 | 205 |
| Concert tickets: row K, seats 14 and 15, doors at 7:30. | 55 | 440 | 200 |
| A single lamp was burning in the window of the house at the end of the lane. | 76 | 608 | 217 |
| Привет! Как дела? | 17 | 240 | 445 |
