---
name: strategy-replay
description: How to test a strategy or a rule change on past broker bars before it trades money. Fetch 1-minute and 5-minute bars, convert them, calibrate option prices, run tools/replay, compare with the random baseline, and decide. Load in research mode, or when the user wants to change a strategy rule.
user-invocable: false
---

# Strategy replay

Terms are defined in trading-terms. The replay runs a strategy's rules over past sessions with modeled option prices. A rule change goes live only after it passes here. Place no orders while you replay.

## What it models

- Entries one minute after the signal bar closes, at that minute's open.
- Option prices from Black-Scholes at one implied volatility per symbol. There is no change in volatility during a trade.
- A bank order fills at the bank price when the modeled price reaches it.
- A fixed cost per contract per round trip, 0.03 by default.
- One position at a time. The first symbol with a signal takes it.

So the results are estimates. They compare rules with each other well. They do not predict the dollars a live session makes.

## Get the bars

1. Call `get_equity_historicals` for the allowed symbols with `interval: "5minute"` and `bounds: "regular"`. Cover the last 20 to 40 sessions.
2. Call it again with `interval: "minute"`, at most 12 sessions per call. Reason: the broker refuses more than 5,000 bars per symbol.
3. Large results are saved to a file, and the tool message gives its path. Do not read that file into the conversation.
4. Convert the saved files: `node tools/replay/bars.js journal/replay <saved file> [<saved file> ...]`.

The script merges new bars into `journal/replay/5minute.csv` and `journal/replay/minute.csv`. The first session only warms up the indicators.

## Calibrate option prices

Use a real quote from the journal for each symbol: the underlying price, strike, minutes to 16:00, and mid.

```text
node tools/replay/run.js --calibrate C <underlying> <strike> <minutes to 16:00> <mid>
```

Pass the results with `--iv SPY=0.09,QQQ=0.13` (illustrative values).

## Run

```text
node tools/replay/run.js --strategy index-level-scalp,index-trend-scalp --hours
node tools/replay/run.js --strategy random
```

Options: `--to HH:MM` moves the entry cutoff, `--bank-atr`, `--stop-atr`, and `--time` change the bracket, `--cost` the cost, `--trades` lists every trade. `node tools/replay/run.js` with no strategy runs index-level-scalp.

## Test a rule change

1. Change the rule in `tools/replay/strategies.js`. Keep it identical to the skill text you propose.
2. Run the old rule and the new rule on the same bars.
3. Run the robustness checks in the table.
4. Write the results in the journal, with the commands.
5. Propose the skill change to the user. Do not change a skill during market hours.

A change passes only when all of these are true:

| Check | Pass |
| --- | --- |
| Baseline | The profit factor beats `--strategy random` with the same exits. |
| Quality | The profit factor is 1.2 or more. |
| Both halves | The first and second half of the sessions are both positive. |
| Option prices | It stays above 1.0 with each `--iv` value 2 points higher. |
| Costs | It stays above 1.0 with `--cost 0.05`. |

If a check fails, keep the old rule. Tell the user which check failed.

## What this is bad at

- Small samples. 20 sessions hold one market regime. Re-run it every month on new sessions.
- Fitting. Every extra run on the same bars makes a good result less likely to hold. Prefer few, simple rules.
- Quotes. Spreads, fills, and volatility changes are modeled, not observed.
