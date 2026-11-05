# Replay of opening-range-breakout, 2026-10-08 to 2026-11-04

Written 2026-11-05, before building a profile for the day-trader. Tool: `tools/replay/orb.js`. Every number here is reproducible with the commands below.

**Not financial advice.** Modeled option prices on 20 sessions. The symbols are the ones the day-trader's own scan returned on 2026-11-03; they are test inputs, not recommendations.

## Question

Does the day-trader's only strategy, opening-range-breakout as its skill states it, have an edge for this account: a $250 per-order cap, options or shares, at most 2 positions?

## Setup

- Symbols: EWZ, T, NU, JD, GME, SOFI, PFE, AAL, F, RIVN (all from the 2026-11-03 scan: $10 to $40, 30-day average volume over 2M, active options). Plus SPY and QQQ as a second test.
- Bars: broker 1-minute and 5-minute regular-session bars, 21 sessions (the first gives the prior close).
- Options: the skill's contract rules. Nearest weekly expiry with 1 to 7 days left, never same-day; the strike nearest delta 0.5 inside 0.40 to 0.60; premium stop at the 25% loss ceiling. Black-Scholes at each symbol's implied volatility, calibrated on the 2026-11-04 close quotes of its 2026-11-06 at-the-money call. Model deltas matched the broker's within 0.01 on all ten.
- Costs: each symbol's measured bid-ask spread per round trip, plus about $0.04 per contract. Shares: 0.05% per round trip.
- Rules mirrored from the skill: 09:30 to 09:45 range, 0.3% to 2.0% range size, 1.5× volume, VWAP side, 3% gap filter, first valid break, entries to 11:00, 0.1% chase limit, reward-to-risk 1.2, stop at the range side (midpoint above 1%), target 1.5× range, breakeven after 1× range, exits on a close back inside the range or across VWAP, flat by 15:50.

## Results

| Run | Trades | Per day | Won | PF | Avg R | Net $ | Green days |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ORB, options, as written | 8 | 0.4 | 0% | 0.00 | −0.77 | −343 | 0/20 |
| ORB, options, no chase limit (diagnostic) | 15 | 0.8 | 13% | 0.07 | −0.72 | −614 | 1/20 |
| Random entries, options, same exits and costs | 34 | 1.7 | 21% | 0.26 | −0.73 | −1,479 | 4/20 |
| ORB, shares, as written | 10 | 0.5 | 40% | 0.63 | −0.07 | −1 | 2/20 |
| ORB, shares, no chase limit | 23 | 1.1 | 43% | 0.81 | −0.07 | −3 | 7/20 |
| Random entries, shares | 41 | 2.0 | 51% | 1.66 | +0.18 | +20 | 11/20 |
| ORB on SPY and QQQ, either instrument | 0 | 0 | — | — | — | 0 | — |

What blocked signals (options, as written): range outside 0.3% to 2.0% on 51 symbol-days; the open of the next bar already past the 0.1% chase limit on 45; no contract in the delta band on 2; gap over 3% on 2.

## Findings

1. **No edge in the signal.** On shares, where costs are small, the breakouts averaged −0.07 R and lost to random entries. Most exits were a close back inside the range within 5 to 45 minutes: false breaks.
2. **The options make it worse.** At the close of 2026-11-04 the at-the-money weekly calls cost $0.14 to $0.51, and their spreads were 4% to 37% of the price. Even random entries lost 73% of their risk on average. A small account buying cheap stock options pays most of its edge to the spread.
3. **Shares are too small to matter.** At a $250 cap, a full ORB win on shares is a few dollars.
4. **Index ETFs give no trades.** On SPY and QQQ, half the days had a range under 0.3%. On the rest, no break passed the volume filter, because the opening bars are the day's busiest. The skill already lists this weakness.
5. Live sessions agree: on 2026-11-03 the day-trader found five breaks, all failed the volume filter, and only one symbol had options that fit its rules.

## Limits

- One scan's symbols, 20 sessions. The sample includes a Brazil-linked shock on 2026-10-26 (EWZ −19.8%, NU −16.9%).
- Spreads were measured once, at the close, and are often tighter mid-morning. The share results do not depend on spreads, and they show no edge either.
- One fixed volatility per symbol; no change in volatility after a move.

## Reproduce

```text
node tools/replay/bars.js journal/replay-stocks <saved get_equity_historicals responses>
node tools/replay/orb.js
node tools/replay/orb.js --baseline random
node tools/replay/orb.js --instrument equity
node tools/replay/orb.js --no-chase --by-symbol
node tools/replay/orb.js --data journal/replay
```

`journal/replay-stocks/calibration.json` holds each symbol's `iv` and `spread`.
