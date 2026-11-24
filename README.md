# Pump.fun Momentum Scalper

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Arkanjak/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Arkanjak/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Referral code: `ne0pfbnn`

A momentum scalping bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) (`agent-fun/replay/v2`).
It watches each new bonding curve's early trade flow and buys young coins
whose recent trades are strongly buy-dominated with a small rising price,
then exits fast on a take-profit (+10%), stop-loss (−5%), trailing exit, or
a short time exit. One small 0.05 SOL buy per coin, at most 5 open
positions, so the book spreads across many distinct coins (104 round trips
of ≥0.01 SOL on the dev dataset) with a tiny max drawdown (0.67% on dev).
Fully deterministic: no clock, environment, or randomness is read, so two
runs produce byte-identical action logs.

## Run

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (see
`vendor/makefun-bot.ts`, the kit's wire shim). It needs Node 22+ and zero
dependencies — no build or install step.

## Local test

A replay driver (kept outside this repo) feeds the kit's dev dataset
through the bot and simulates fills at slot + 2 with constant-product math:

- Dev replay: 63,369 batches, 208 fills, 104 distinct coins traded,
  104 round trips ≥ 0.01 SOL, net PnL −0.060 SOL, max drawdown 0.67%.
- Same action-log sha256 from two different working directories
  (`dd1094391a7a778da5a2cc3fbc72383353a279e754bc78b549e17bb4e5947554`).

## License

MIT — see [LICENSE](LICENSE).
