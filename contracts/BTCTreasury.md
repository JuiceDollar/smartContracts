# BTCTreasury — Leveraged BTC Without Liquidation Risk

## Who Benefits Most: JUICE Holders

This module fundamentally transforms what JUICE is. Today, JUICE is a passive governance
token that earns protocol fees. With BTCTreasury, **JUICE becomes a leveraged BTC product
without liquidation risk** — the same value proposition that made Strategy's MSTR stock one
of the best-performing assets in traditional finance.

The shift:

| Before BTCTreasury | After BTCTreasury |
|--------------------|-------------------|
| JUICE = governance token + passive fee income | JUICE = **leveraged BTC exposure + fee income** |
| Narrative: "equity in a stablecoin protocol" | Narrative: **"the MSTR of Bitcoin L2"** |
| Revenue: fees from positions and liquidations | Revenue: **direct BTC appreciation via rebalancing** |
| Risk: capped by liquidation mechanism | Risk: uncapped downside, but also **uncapped upside** |
| Appeal: DeFi governance participants | Appeal: **anyone who wants leveraged BTC without margin calls** |

JUICE holders are the primary beneficiaries because:

1. **Direct leverage on BTC** — Protocol owns the BTC, not individual users. When BTC rises,
   `rebalance()` mints JUSD profit directly to equity → JUICE price goes up
2. **Symmetric risk** — JUICE has both the upside AND downside, not just downside like a lending protocol
3. **No abandoned positions** — Protocol owns everything. No black holes, no reserve contamination.
4. **Strongest investment narrative** — "Leveraged BTC without liquidation" is dramatically more
   compelling than "stablecoin governance token"

## The Key Design Insight: Protocol Owns the BTC

Previous design (v1, WRONG): Users deposit cBTC → mint JUSD → users keep BTC upside → JUICE
only gets interest. This is a lending protocol, not the Strategy model.

**Correct design (v2): The PROTOCOL owns the cBTC.** Users buy JUICE with cBTC. The cBTC stays
in the treasury permanently. JUICE IS the leveraged BTC exposure.

| Strategy (TradFi) | BTCTreasury (DeFi) |
|-------------------|--------------------|
| Investor buys STRC → Strategy gets USD → buys BTC | User calls `investBTC()` → protocol gets cBTC |
| Strategy OWNS the BTC | Treasury contract OWNS the cBTC |
| STRC holders get dividends only | JUSD savers get savings interest only |
| MSTR shareholders get BTC upside | **JUICE holders get BTC upside via `rebalance()`** |
| No margin call — Strategy holds through drawdowns | No liquidation — treasury holds through drawdowns |
| Board decides STRC issuance volume | Governance sets `mintCeiling` |

## How It Works

### Core Flow: `investBTC()` — Buy JUICE with cBTC

```
Alice has 2 cBTC → calls investBTC(2 cBTC)

1. Treasury receives 2 cBTC (protocol-owned, permanent)
2. Treasury mints 70,000 JUSD (2 × 35,000 ceiling)
   └─ 56,000 JUSD → usable (80%)
   └─ 14,000 JUSD → minter reserve (20%)
3. 56,000 JUSD invested into equity → JUICE shares minted
4. JUICE shares transferred to Alice

Result:
├─ Protocol owns 2 cBTC (worth ~$140k at $70k/BTC)
├─ Protocol has 70k JUSD of debt
├─ Equity increased by ~56k JUSD
├─ Alice holds JUICE representing her share of equity
└─ Alice has leveraged BTC exposure through JUICE
```

### Upside: `rebalance()` — BTC Appreciation → Equity Profit

```
BTC rises from $70k to $105k (+50%)

Before rebalance:
├─ Treasury: 2 cBTC (now worth $210k)
├─ Minted JUSD: 70,000
├─ Equity hasn't changed (measured in JUSD, not cBTC)

Governance raises ceiling from 35k to 52.5k (still 50% LTV)
Governance calls rebalance():
├─ Max mintable: 2 × 52,500 = 105,000 JUSD
├─ Already minted: 70,000 JUSD
├─ Profit: 35,000 JUSD minted → equity pool
├─ Equity increases by 35,000 JUSD (+62.5%!)
└─ JUICE price increases ~62.5% (> BTC's 50% = LEVERAGE!)
```

### Downside: No Liquidation

```
BTC falls from $70k to $35k (-50%)

├─ Treasury: 2 cBTC (now worth $70k)
├─ Minted JUSD: 70,000 (unchanged)
├─ Position is now "at par" (cBTC value ≈ JUSD debt)
├─ NO liquidation. NO margin call. NO forced selling.
├─ Governance lowers ceiling to reflect lower BTC price
├─ Protocol holds. Waits for recovery.
├─ JUICE price drops (market anticipates lower equity)
├─ If BTC recovers → JUICE recovers
└─ If BTC stays down: governance can sell cBTC via sellBTC()
```

### Leverage Math

```
Variables:
  C = cBTC value in USD
  D = JUSD minted (debt)
  E = C - D (equity)
  LTV = D / C

Leverage = ΔE/E ÷ ΔC/C = C / (C - D) = 1 / (1 - LTV)

At 50% LTV: leverage = 1 / (1 - 0.5) = 2x
At 33% LTV: leverage = 1 / (1 - 0.33) = 1.5x
At 66% LTV: leverage = 1 / (1 - 0.66) = 3x

Example at 50% LTV (35k ceiling, $70k BTC):
  BTC +30% → JUICE +60% (2x leverage)
  BTC -20% → JUICE -40% (2x leverage)
  BTC +100% → JUICE +200% (2x leverage)
```

## Why V2 Fixes V1's Problems

### Problem 1: "JUICE gets no BTC upside" → FIXED

V1: Users deposit cBTC, keep the upside, JUICE only gets interest.
V2: **Protocol owns the cBTC.** `rebalance()` converts BTC appreciation into equity profit.
JUICE has symmetric exposure: upside AND downside.

### Problem 2: "Abandoned positions are black holes" → ELIMINATED

V1: Users can abandon positions → cBTC locked, JUSD unrecoverable.
V2: **No per-user positions.** Protocol owns everything. Nothing to abandon.
Users hold JUICE, which they can sell anytime via `equity.redeem()`.

### Problem 3: "No recovery mechanism" → SOLVED

V1: Underwater positions have no resolution path.
V2: Governance can `sellBTC()` to deleverage. Or simply hold through the drawdown
(like Strategy does). The system is always coherent because there are no user positions.

### Problem 4: "Reserve contamination" → PREVENTED

V1: Bad user debt inflates `minterReserveE6` systemwide.
V2: The treasury is a single protocol-level position. `burnWithoutReserve()` in `sellBTC()`
properly unwinds the reserve. No orphaned reserve entries.

## Contract Functions

### User-Facing
| Function | Purpose |
|----------|---------|
| `investBTC(cbtcAmount, minShares)` | Buy JUICE with cBTC. Protocol owns the BTC. |
| `donateBTC(cbtcAmount)` | Donate cBTC to treasury (increases health ratio for all). |

### Governance (2% quorum)
| Function | Purpose |
|----------|---------|
| `rebalance(helpers)` | Capture BTC upside: mint JUSD profit to equity pool. |
| `sellBTC(buyer, cbtcAmount, jusdPayment, helpers)` | Deleverage: sell cBTC for JUSD, burn JUSD. |
| `proposeMintCeiling(newCeiling, helpers)` | Propose new ceiling (7-day timelock). |
| `applyCeilingChange()` | Apply pending ceiling change. |
| `emergencyStop(helpers, message)` | Permanently halt new investments (10% quorum). |

### View Functions
| Function | Returns |
|----------|---------|
| `btcBalance()` | Total cBTC in treasury |
| `availableToMint()` | Remaining JUSD capacity |
| `healthRatio()` | cBTC value at ceiling / JUSD debt (basis points) |

## Risk Analysis

### For JUICE Holders
- **Leveraged BTC upside** — 2x at 50% LTV
- **Leveraged BTC downside** — same 2x leverage on drops
- **No liquidation** — protocol holds through drawdowns
- **Governance risk** — ceiling must be managed responsibly
- **Worst case** — if BTC drops >50% (at 50% LTV), equity approaches zero

### For JUSD Holders
- **Unchanged peg mechanism** — bridges still provide USDC/USDT redemption
- **Reserve contributions** — investBTC contributes to minter reserve
- **No direct risk** — JUSD obligations are backed by cBTC in treasury
- **Extreme scenario** — if equity() reaches 0, savings interest stops

### For the System
- **No orphaned positions** — protocol manages its own balance sheet
- **Clean reserve accounting** — sellBTC properly unwinds via burnWithoutReserve
- **Governance-dependent** — rebalancing requires active governance participation
- **Single point of management** — simpler than tracking thousands of user positions

## Deployment

1. Deploy `BTCTreasury(jusd, cbtc, wcbtc, reservePPM, initialCeiling)`
2. Register as minter: `JUSD.suggestMinter(treasury, period, fee, message)`
3. Wait for veto period (≥14 days)
4. Once active: users can call `investBTC()` immediately
5. Governance should `rebalance()` periodically to capture BTC upside
