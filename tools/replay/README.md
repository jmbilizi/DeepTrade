# Replay

Tests DeepTrade strategy rules on past broker bars before they trade money. Plain Node 18+, no dependencies. The procedure for agents is in `.claude/skills/strategy-replay/SKILL.md`.

**Not financial advice.** Option prices are modeled (Black-Scholes at a fixed implied volatility). Results compare rule sets with each other. They do not predict live profit.

## Files

| File | What it does |
| --- | --- |
| `bars.js` | Converts saved `get_equity_historicals` responses to `5minute.csv` and `minute.csv`. |
| `lib.js` | New York time, 5-minute indicators (EMA, VWAP, ATR, supertrend), option pricing, the key-levels map. |
| `strategies.js` | Each index strategy's entry rules and exits, mirroring its skill. Plus a random baseline. |
| `run.js` | The command line: replay, summary, by-hour table, trade list, IV calibration. |

## Quick start

```text
# 1. In Claude Code, fetch bars (large results are saved to a file; the tool message gives the path)
#    get_equity_historicals  symbols [SPY, QQQ]  interval 5minute  bounds regular  (20-40 sessions)
#    get_equity_historicals  symbols [SPY, QQQ]  interval minute   (at most 12 sessions per call)
# 2. Convert
node tools/replay/bars.js journal/replay <saved file> <saved file> ...
# 3. Calibrate from a real quote: type, underlying, strike, minutes to 16:00, mid (illustrative values)
node tools/replay/run.js --calibrate C 500.20 501 300 1.20
# 4. Replay and compare with the baseline
node tools/replay/run.js --strategy index-level-scalp,index-trend-scalp --hours
node tools/replay/run.js --strategy random
```

`journal/` is gitignored, so bars stay on your machine.

## Model

- Entry one minute after the signal bar closes, at that minute's open.
- Strike walk from the first out-of-the-money strike; skip below delta 0.35. Contracts = per-order cap ÷ premium.
- Inside a 1-minute bar, the premium stop is tested before the bank order.
- Cost per contract per round trip: `--cost` (default 0.03).
- One position at a time; the first symbol listed with a signal takes it.

Tests: `node tests/replay.test.js`.
