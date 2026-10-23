---
name: opening-range-breakout
description: Intraday strategy. Trade the break of the first 15-minute range in the direction of the break, confirmed by VWAP and volume, with a defined stop and target. Load when a trading agent needs entry, stop, target, and invalidation rules for an opening range breakout.
user-invocable: false
---

# Opening Range Breakout (ORB)

A time-boxed, rule-based intraday setup. The opening range is the high and low of the first 15 minutes of regular trading, 09:30 to 09:45 America/New_York. A breakout is a close outside that range with confirmation. The agent trades the first valid break only.

## Why this strategy first

It is simple to state, easy to verify after the fact, and limited to a narrow window so the agent is not hunting all day. It is also well known, which means it works less often than it did and demands strict filters. Expect many days with no trade.

## Data this strategy needs

- 5-minute bars (open, high, low, close, volume) for the session so far.
- VWAP for the session, or enough bar data to compute it.
- A fresh quote with bid and ask at decision time.

Robinhood's Trading MCP exposes quotes, positions, and orders. At the time of writing it is not known to expose intraday bars or VWAP. If no tool returns bars and VWAP, do not approximate them from polled quotes. Tell the user this strategy cannot run with the connected data sources and offer research mode, or ask them to add a market data MCP that provides bars.

## Parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| Range window | 09:30 to 09:45 | 5-minute range is more aggressive, 30-minute more conservative |
| Entry window | 09:45 to 11:00 | No ORB entries after 11:00 |
| Confirmation bar | 5-minute close | Not a wick, a close |
| Minimum range | 0.3% of price | Tighter ranges produce false breaks |
| Maximum range | 2.0% of price | Wider ranges make the stop too far for the risk budget |
| Volume filter | Breakout bar volume at least 1.5x the average 5-minute volume of the range bars | |
| VWAP filter | Longs require price above VWAP, shorts below | |
| Target | 1.5x the range height from the breakout level | Partial at 1x is allowed if the plan permits |
| Stop | Opposite side of the range, or the range midpoint for ranges above 1% | Choose before entry, never widen |

## Entry rules

**Long**

1. A 5-minute bar closes above the opening range high.
2. That bar's volume meets the volume filter.
3. Price is above VWAP at the close of that bar.
4. The range meets the minimum and maximum size filters.
5. No plan no-trade condition is active.

Enter at market on the open of the next bar, or with a limit no worse than 0.1% above the breakout level.

**Short** mirrors the above below the range low and below VWAP. Only take shorts if the plan allows shorting and the account supports it. Robinhood agentic accounts may not. If in doubt, longs only.

## Stop and target

- Stop at the opposite side of the range by default. For ranges above 1% of price, use the range midpoint.
- Target at breakout level plus 1.5 times the range height. For a long: `ORH + 1.5 * (ORH - ORL)`.
- If the reward-to-risk at the planned entry is below 1.2, skip the trade.
- Once price reaches 1x range height in profit, the stop may be moved to breakeven. That is the only permitted stop adjustment.

## Invalidation and exit

Exit immediately, before stop or target, if any of these happens:

- A 5-minute bar closes back inside the range after entry.
- Price crosses back through VWAP against the position and closes there.
- A scheduled high-impact release is within 10 minutes.
- The plan's flat-by time arrives.

## What this strategy is bad at

- Choppy, low-volume days. The range breaks both ways and stops out twice. The volume filter helps but does not cure it.
- Gap-and-go days where the move happens before 09:45. Then the range is already extended and the breakout comes too late. Skip if the stock is already up more than 3% from the prior close at 09:45.
- Index ETFs on quiet days. SPY and QQQ often produce ranges under the minimum size.
- Anything with news dropping mid-range.

## Recording the setup

Before the order, write in the journal: ORH, ORL, range %, breakout bar time, breakout bar volume vs average, VWAP, entry, stop, target, reward-to-risk, and position size. Afterwards record fill, exit reason, and result in R multiples.

## Example

Opening range on XYZ (a made-up symbol): high 101.20, low 100.40. Range 0.80, which is 0.79% of price, inside the size filters. At 09:55 a 5-minute bar closes at 101.35 on volume 2.1x the range average, VWAP 100.85. All entry conditions met.

Entry limit is at most 0.1% above the breakout level: 101.20 x 1.001 = 101.30. Stop at the opposite side, 100.40, so risk is 0.90 per share. Target is 101.20 + 1.5 x 0.80 = 102.40, so reward is 1.10 per share. Reward-to-risk 1.22, which clears the 1.2 minimum. Valid trade at 101.30 or better.

If the limit does not fill and price is already 101.35, risk becomes 0.95 and reward 1.05, reward-to-risk 1.1. Skip. Do not chase. The 0.1% entry rule exists because this strategy's edge disappears quickly with slippage.
