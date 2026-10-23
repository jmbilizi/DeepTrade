# Disclaimer

Read this before you connect a brokerage account.

## What this project is

DeepTrade is an open-source collection of agent definitions, skills, hooks, and configuration for Claude Code. It makes it easier to run an AI trading agent against your own brokerage account. It is a toolkit, not a service. There is no server, no hosted component, and nobody at the project can see or control your account.

## What it is not

- **Not financial advice.** Nothing in this repository, including strategy skills, example configurations, documentation, or agent output, is a recommendation to buy, sell, or hold any security, option, or digital asset.
- **Examples are placeholders.** Ticker symbols, dollar caps, percentages, watchlists, and time windows in `.env.example`, `config/`, skills, and docs were chosen to illustrate the file format and nothing more. Their presence does not mean the authors trade them, endorse them, or think they are suitable for you.
- **Not a broker or adviser.** The authors and contributors are not registered broker-dealers, investment advisers, or financial professionals, and do not act in any fiduciary capacity toward you.
- **Not supervised.** Nobody at this project reviews, audits, or monitors what an agent does in your account. Check your broker's own terms for what it does and does not take responsibility for when an external agent is connected. At the time of writing, Robinhood's documentation states that it does not guarantee the accuracy, completeness, or suitability of agent output.
- **Broad read access.** Robinhood's documentation states that a connected agent can read all of your Robinhood accounts, including account numbers, positions, balances, and order history, while placing trades only in the dedicated agentic account. The journal hook redacts account numbers from what it writes, but the agent still sees them during a session.
- **Not guaranteed to work.** Strategies may be wrong. Market data may be delayed or incorrect. Models hallucinate. Hooks can be bypassed by misconfiguration. Orders may fill at prices you did not expect, or fail to fill at all.

## You are responsible for

- Every order placed through your account, whether you approved it individually or allowed the agent to act without asking.
- Funding the agent's account only with money you can afford to lose entirely.
- Complying with your broker's terms of service, including any terms specific to agentic or automated trading.
- Complying with the securities, tax, and other laws that apply to you.
- Reviewing and understanding any strategy skill before enabling it.
- Setting and maintaining the guardrails in `.env`, and understanding that they are a safety net, not a substitute for judgment. The risk gate estimates order value from the fields it recognizes in a request. It can be wrong, it cannot see fills, and it does not enforce the plan's stop losses or daily loss limit. Those live only in the agent's instructions.

## Risk

Trading involves substantial risk of loss. Intraday trading, options, leverage, and digital assets carry additional risk and can lose more than the amount invested in some cases. Past performance of any strategy, real or backtested, does not predict future results. An AI agent can lose money quickly and repeatedly.

## No warranty and limitation of liability

This software is provided "as is" without warranty of any kind. To the maximum extent permitted by law, the authors and contributors shall not be liable for any direct, indirect, incidental, consequential, or other loss or damage arising from the use of this software, including trading losses, fees, tax consequences, missed opportunities, or account restrictions. See the LICENSE file for the governing terms.

## Third parties

Robinhood, Anthropic, Claude, and other names are trademarks of their respective owners. This project is not affiliated with, endorsed by, or sponsored by any of them. Broker features, availability, and terms can change without notice and may differ by region.

If you do not agree with all of the above, do not use this software.
