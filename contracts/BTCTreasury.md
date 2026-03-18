# BTCTreasury — Leveraged BTC Without Liquidation Risk

## The Problem

JUSD currently offers collateralized minting via the MintingHub: users deposit cBTC, mint JUSD,
and face liquidation through the challenge/auction system if their collateral drops below the
required threshold.

This is great for maintaining the JUSD peg, but it means every borrower carries **liquidation risk**.
In a severe BTC downturn, positions get challenged, collateral is auctioned off, and borrowers
lose their BTC at the worst possible time — exactly when they should be holding.

Meanwhile, JUICE (the equity token) earns fees passively but has no direct, leveraged exposure
to BTC price movements.

## The Inspiration: Strategy's STRC/MSTR Model

Strategy (formerly MicroStrategy) pioneered a financial structure that solves this exact problem
in traditional finance:

| Component | Role |
|-----------|------|
| **STRC** (preferred stock) | Pays ~10% annual dividend. No buyback obligation. If everyone sells, the price drops below $100 par — but Strategy doesn't have to repurchase. |
| **MSTR** (common stock) | Equity holders. Leveraged BTC exposure. When BTC rises, MSTR rises more (leverage). When BTC falls, MSTR falls more — but there is **no margin call, no liquidation, no forced selling**. |
| **BTC Treasury** | Strategy holds BTC on its balance sheet, funded by STRC issuance. The BTC is never force-sold. |

The key insight: **MSTR is a leveraged BTC product without liquidation risk**, because STRC
holders have no right to demand their principal back. They only receive dividends. If Strategy
goes deep underwater, they just... wait. No margin call. No death spiral.

## Mapping to JUSD

| Strategy | JUSD + BTCTreasury |
|----------|-------------------|
| STRC (preferred stock, ~10% yield) | JUSD (stablecoin, savings yield) |
| MSTR (equity, leveraged BTC) | **JUICE (equity, leveraged BTC)** |
| Strategy's BTC treasury (no liquidation) | **BTCTreasury contract (no challenges)** |
| Strategy's board sets STRC issuance volume | Governance sets `mintCeiling` |
| STRC holders can't force BTC liquidation | JUSD holders can't force cBTC liquidation |
| Spread: BTC returns minus STRC dividend | Spread: BTC returns minus savings interest |

## How BTCTreasury Works

### Core Concept

BTCTreasury is a standalone minter contract (registered via `suggestMinter()`) that:

1. **Holds cBTC** as collateral
2. **Mints JUSD** against it via `mintWithReserve()`
3. **Has NO challenge/liquidation mechanism** — positions cannot be force-closed
4. **Charges interest** (leadrate + risk premium) that flows to the equity pool as profit

### User Flow

```
Alice deposits 1 cBTC into BTCTreasury
    ↓
Alice mints 30,000 JUSD (at mintCeiling of 35,000 JUSD/cBTC)
    ↓
Alice receives 24,000 JUSD (80%, after 20% reserve contribution)
    ↓
6,000 JUSD goes to equity pool as reserve
    ↓
Interest accrues at ~10% p.a. on the 24,000 JUSD she received
    ↓
Interest payments flow to equity pool → benefit JUICE holders
    ↓
When Alice wants her cBTC back: repay 30,000 JUSD + accrued interest → withdraw cBTC
```

### What Happens When BTC Drops

```
BTC drops 50%:
├─ Alice's 1 cBTC is now worth ~$35,000 (was ~$70,000)
├─ Alice's 30,000 JUSD debt is unchanged
├─ Position is technically "underwater"
├─ BUT: No challenge, no auction, no liquidation
├─ Treasury just holds the cBTC
├─ Equity pool absorbs the theoretical loss
│   └─ JUICE price drops (less equity backing)
├─ If BTC recovers → equity recovers → JUICE recovers
└─ Alice still owes 30,000 JUSD + interest to reclaim her cBTC

BTC rises 100%:
├─ Alice's 1 cBTC is now worth ~$140,000
├─ Alice's debt is still 30,000 JUSD + interest
├─ Equity pool benefits massively (cBTC value >> outstanding JUSD)
│   └─ JUICE price rises significantly
├─ Alice can repay ~30,000 JUSD + interest and reclaim her cBTC
└─ Net result: Alice kept her leveraged BTC exposure through the upswing
```

### The JUICE Leverage Effect

JUICE holders benefit from a natural leverage mechanism:

1. BTCTreasury holds X cBTC (collateral) and has Y JUSD outstanding (debt)
2. Equity = value of cBTC holdings - outstanding JUSD obligations
3. JUICE market cap = VALUATION_FACTOR (10) × Equity

When BTC rises 20%:
- If cBTC is worth $100M and JUSD debt is $50M → Equity goes from $50M to $70M (+40%)
- JUICE market cap goes from $500M to $700M (+40%)
- That's 2x leverage on BTC price movements

When BTC falls 20%:
- Equity goes from $50M to $30M (-40%)
- JUICE takes the hit, but there's no forced selling
- Protocol survives, waits for recovery

This is exactly how MSTR works: leveraged BTC exposure without the risk of being liquidated
at the bottom.

## Price Discovery Without Oracles

JUSD is oracle-free by design. The existing MintingHub uses challenges/auctions for price
discovery. BTCTreasury cannot use challenges (that's the whole point), so it needs an
alternative:

**Governance-set `mintCeiling`**: Qualified JUICE holders (2% quorum) can propose a new
maximum JUSD mintable per cBTC, subject to a 7-day timelock. This is analogous to how
Strategy's board decides how much STRC to issue.

The ceiling should be set conservatively (e.g., 50% LTV at current BTC prices):
- BTC at $70,000 → ceiling could be 35,000 JUSD/cBTC
- BTC rises to $100,000 → governance can raise ceiling to 50,000 JUSD/cBTC
- BTC falls to $40,000 → governance should lower ceiling (or leave it, existing positions survive)

The 7-day timelock prevents governance attacks and gives the community time to veto
harmful changes.

## Interest Rate Model

BTCTreasury charges a **fixed annual rate** on each mint, composed of:

- **Leadrate** (system-wide savings interest rate, e.g., 5%)
- **Risk premium** (additional charge for the no-liquidation privilege, e.g., 5%)
- **Total**: ~10% p.a. (comparable to STRC's ~10-11.5% dividend)

The rate is locked in at mint time and applied to the "usable principal" (the amount the user
actually received, excluding the reserve portion). Interest accrues continuously and is
collected as profit for the equity pool when the user repays.

This means: even if BTC doesn't move at all, JUICE holders earn 10% annually on all
outstanding BTCTreasury debt — funded by the borrowers who chose the safety of no
liquidation.

## Risk Analysis

### For BTCTreasury Users (Borrowers)
- **No liquidation risk** — the primary benefit
- **Interest cost** — higher than regular positions (risk premium)
- **Ceiling changes** — governance could lower the ceiling, but this doesn't affect existing debt
- **Opportunity cost** — cBTC is locked until debt is repaid

### For JUICE Holders (Equity)
- **Leveraged BTC upside** — the primary benefit
- **Leveraged BTC downside** — equity can decrease significantly in a crash
- **No forced selling** — even in a crash, no cBTC is liquidated, so recovery is possible
- **Interest income** — steady yield from borrower interest payments
- **Worst case** — if equity() reaches 0, savings interest stops (but system doesn't collapse)

### For JUSD Holders (Stablecoin Users)
- **Peg stability** — cBTC collateral backs outstanding JUSD, plus reserve contributions
- **Savings yield** — funded by borrower interest (same as with MintingHub positions)
- **No buyback guarantee** — like STRC, JUSD has no redemption right against the protocol
- **Bridge redemptions** — users can still redeem via stablecoin bridges for USDC/USDT

## Comparison: BTCTreasury vs Regular Positions

| Feature | Regular Position (MintingHub) | BTCTreasury |
|---------|------------------------------|-------------|
| Collateral | Any approved token | cBTC only |
| Liquidation | Challenge + Dutch Auction | **None** |
| Oracle | Challenge-based price discovery | Governance-set ceiling |
| Interest rate | Leadrate + risk premium | Leadrate + **higher** risk premium |
| Reserve contribution | Configurable per position | Fixed (e.g., 20%) |
| JUICE holder risk | Limited (liquidation caps losses) | **Higher** (no liquidation floor) |
| JUICE holder reward | Fees + liquidation profits | **BTC leverage + interest income** |
| User risk | Liquidation in downturns | Higher interest cost |
| User reward | Lower interest cost | **No liquidation risk** |

## Technical Implementation

BTCTreasury is a single Solidity contract (~300 lines) that:

1. Is registered as a minter via `suggestMinter()` (14-day governance veto period)
2. Holds cBTC in the contract balance
3. Calls `JUSD.mintWithReserve()` to create new JUSD
4. Tracks per-account collateral, principal, and interest
5. Allows repayment via `JUSD.burnFromWithReserve()` and `JUSD.collectProfits()`
6. Supports native cBTC (via WcBTC wrapping/unwrapping)
7. Has governance controls (mint ceiling with timelock) and emergency stop (10% quorum)

The contract has no admin keys, no upgradeability, and no special privileges beyond being
a registered minter — fully aligned with JUSD's cypherpunk principles.

## Deployment Steps

1. Deploy `BTCTreasury` contract with parameters:
   - JUSD address, cBTC address, Leadrate/Savings address, WcBTC address
   - Risk premium (e.g., 50,000 PPM = 5%)
   - Reserve PPM (e.g., 200,000 = 20%)
   - Initial mint ceiling (e.g., 35,000 × 10^18 = 35,000 JUSD per cBTC)

2. Register as minter:
   - Call `JUSD.suggestMinter(treasuryAddress, applicationPeriod, fee, message)`
   - Wait for application period (minimum 14 days) without governance veto

3. Once active: users can deposit cBTC and mint JUSD immediately

## Future Considerations

- **Multiple collateral types**: The current design is cBTC-only. Future versions could
  support other volatile assets (wrapped ETH, tokenized stocks, etc.) with separate
  ceiling parameters per collateral.

- **Dynamic ceiling**: An automated ceiling adjustment mechanism based on time-weighted
  average prices from existing MintingHub positions could reduce governance overhead.

- **Abandonment handling**: Long-term inactive accounts (e.g., no interaction for 2+ years)
  could have a governance-triggered wind-down mechanism — though this should be
  very conservative to maintain the "no liquidation" guarantee.

- **Integration with Savings**: BTCTreasury interest could be earmarked specifically for
  savings yields, creating a direct link between borrower interest payments and saver
  returns (like STRC dividends funding preferred stock yield).
