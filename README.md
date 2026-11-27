# png-squeeze-01 — Squeeze screenshots into the smallest PNG

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/shusay12/makefun-png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/shusay12/makefun-png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

<sub>Entered on [make.fun](https://make.fun/?ref=susay21&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>

One program, `main.ts` (Node 22, stdlib only, no network), that answers all 8
instances of a set in one run: it reads `/input/<id>/image.png` (1280x720 RGBA)
and writes a lossless PNG to `/output/<id>/image.png`, in as few bytes as it can.

## How it squeezes

1. **Colour-type reduction** — palette (type 3 + tRNS) when the image holds at
   most 256 colours, grey (0/4) when every pixel is grey, RGB (2) when fully
   opaque, and a tRNS key when every non-opaque pixel is one fully-transparent
   value.
2. **Per-row filter choice** — fixed filters, minimum-sum and fewest-distinct-
   pairs heuristics, plus per-row brute-force probes, screened with zlib level 9.
3. **Custom DEFLATE encoder** — lazy matching with long hash chains (4096),
   cost-aware match acceptance, and per-block (256 KiB) dynamic Huffman tables,
   falling back to fixed Huffman when smaller. The custom stream is verified to
   round-trip exactly before it is used; otherwise the zlib level 9 stream wins.

Everything is deterministic: no clock, no environment reads, no randomness —
two runs write byte-identical outputs. The whole set runs in ~30 s on one CPU,
inside the 60 s wall budget.

## Practice-set result (dev signal only, not a final result)

Local grade on the kit's practice set: **707,814 / 1,000,000** (mean ~708
points/instance), vs the house baseline (fixed-paeth) at ~420,000 and the
reference compressor at ~760–790 points/instance. Practice scores are a dev
signal only; the scored set is drawn after the deadline.

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Or with the kit's grader (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## Licence

MIT — see `LICENSE`.
