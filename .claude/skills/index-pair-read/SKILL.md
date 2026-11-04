---
name: index-pair-read
description: Reads two or more highly correlated broad index ETFs from DEEPTRADE_ALLOWED_SYMBOLS together. Scores relative strength on a volatility-scaled basis, decides whether the indexes confirm or diverge, picks the one instrument to put the trade in, and sets the size tier. Load when a strategy trades index ETFs and more than one is allowed.
user-invocable: false
---

# Index pair read

Broad index ETFs move together most of the day. Holding one position in each is nearly the same bet twice, so a signal goes into **one** of them, the one that fits best, with the whole size. The other is read as a witness.

## Evidence

Daily return correlation between the large US index ETFs is about 0.9 or higher, with the more tech-heavy ones more volatile. At a correlation of 0.95, splitting one position across two index ETFs reduces risk by only about 1 to 2%. Divergence rules ("SMT") are practitioner opinion with no published test; here they only reduce size or tighten exits, never open a trade. Sources and grades: `docs/research/index-0dte-trade-management.md`.

## Inputs, per allowed symbol

From the strategy or the intraday-technicals skill: today's open, last price, session VWAP, ATR(14) on 5-minute bars, the trend state, and the session high and low with their times. If the strategy computes a volatility band (for example, the noise area in index-intraday-momentum), use its half-width.

## Relative strength

Scale each move by that symbol's own volatility, never raw percent:

```text
unit   = band half-width at this check (open × sigma), or ATR(14, 5m) × 4 if the strategy has no band
score  = (last - open) / unit
```

The symbol with the higher score is stronger. For a long, the candidate is the strongest; for a bearish trade, the weakest. When the scores differ by less than 0.25, call it a tie.

## Confirm or diverge

For a long signal in the candidate (mirror for bearish):

| Witness (the other index) | Read | Size tier |
| --- | --- | --- |
| Same signal, or trend state `up` and above VWAP | Confirmed | Full: the size position-sizing allows |
| Above VWAP, trend state `mixed` | Partial | Half of that size, rounded down, but at least 1 contract or the minimum share lot |
| Below VWAP, or trend state `down` | Disagrees | No entry |

**Divergence while in a trade.** If the candidate makes a new session high and the witness fails to make a new high within 15 minutes, while it was at a session high in the last 60 minutes, flag `diverging`. The trade-management ladder treats it as a reason to tighten: move to the stage-1 breakeven stop at once, if the position is in profit. Divergence never opens a trade and never moves a stop away from price.

## Picking the instrument

When two symbols are tied or both qualify, prefer in order:

1. The option contract with the smaller spread as a percent of mid, among those that pass the strategy's spread rule.
2. The one where a whole contract fits the per-order cap closer to the money.
3. Higher delta per dollar of premium.

For shares, prefer the one with the smaller spread in percent.

## Rules

- One open position across the allowed index ETFs at a time, unless the strategy explicitly allows more.
- Put the size in one instrument. Do not buy one contract in each to "spread" the bet; buy the count position-sizing allows in the chosen one.
- Record on the trade card: both scores, the witness read, the tier, and why this instrument.

## What this is bad at

- Days when one index moves alone on sector news. A confirmation rule can skip a real trend in the leader.
- The first 30 minutes, when index correlation is lowest and divergence is mostly noise.
- It is a read, not an edge. None of these rules has been backtested.

## Example

Illustrative only: made-up symbols AAA and BBB, made-up numbers.

AAA: open 400.00, last 401.60, band half-width 1.20, score 1.33. BBB: open 300.00, last 300.90, half-width 1.50, score 0.60. Long signal. AAA is the candidate. BBB is above VWAP with trend state `up`, so it confirms: full size in AAA. If BBB had been below VWAP, no entry.
