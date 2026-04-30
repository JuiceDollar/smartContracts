# JUSD-2026-001: Cooldown Blocks Debt-Free Collateral Withdrawal

| Field              | Value                                                    |
|--------------------|----------------------------------------------------------|
| **Severity**       | High                                                     |
| **Type**           | Griefing / Denial of Service                             |
| **Component**      | Position (V3)                                            |
| **Status**         | Fixed ([PR #95](https://github.com/JuiceDollar/smartContracts/pull/95)) |
| **Date Reported**  | 2026-04-29                                               |
| **Affected Files** | `MintingHubV3/Position.sol`                              |
| **Origin**         | Inherited from Frankencoin / d-EURO fork                 |

---

## Summary

The `withdrawCollateral()` function unconditionally checks the `noCooldown` modifier, even when the position has zero outstanding debt. An attacker can exploit this by repeatedly creating challenges and immediately self-averting them — a zero-cost operation that imposes a 1-day cooldown each time, permanently blocking the position owner from withdrawing their collateral.

When the position expires while the owner is locked out, the collateral is sold through the `buyExpiredCollateral()` auction at virtual price (based on liquidation price) instead of market price. The owner receives the auction proceeds minus debt and fees — potentially far below the market value of their collateral.

The fix: bypass the cooldown check on withdrawal when the position has no outstanding debt (`_getDebt() == 0`). A debt-free position has no minting risk, no collateral requirement, and no reason to restrict the owner.

---

## Root Cause

Three components interact to create the vulnerability:

### 1. Free Self-Avert (MintingHub.sol, `_avertChallenge`)

```solidity
if (msg.sender == _challenge.challenger) {
    // allow challenger to cancel challenge without paying themselves
} else {
    JUSD.transferFrom(msg.sender, _challenge.challenger, (size * liqPrice) / (10 ** 18));
}

_challenge.position.notifyChallengeAverted(size);  // <-- always called
```

When the challenger bids on their own challenge (self-avert), no JUSD payment is required. The challenger's collateral is returned in full. The only cost is gas — approximately $0.01 per cycle on Citrea L2.

### 2. Unconditional Cooldown on Aversion (Position.sol, `notifyChallengeAverted`)

```solidity
function notifyChallengeAverted(uint256 size) external onlyHub {
    challengedAmount -= size;
    _restrictMinting(1 days);  // <-- always sets 1-day cooldown
}
```

Every aversion — including a free self-cancellation — triggers a 1-day cooldown. This cooldown blocks both `withdrawCollateral()` and `mint()` via the `noCooldown` modifier. The cooldown is justified for minting (prevents minting at overvalued prices) but not for withdrawal when there is no debt.

### 3. Cooldown Applied to Withdrawal Regardless of Debt State

```solidity
function _withdrawCollateral(...) internal noCooldown noChallenge returns (uint256) {
```

The `noCooldown` modifier blocks withdrawal even when the position has zero debt. At that point, the cooldown serves no protective purpose:
- **Minting** is irrelevant (nothing to mint against)
- **Re-challenges** are irrelevant (nothing to liquidate)
- **`_checkCollateral`** passes trivially (collateral requirement = 0)
- The owner has fulfilled their obligation (debt repaid) and should receive their collateral

### Asymmetry with `forceSale`

| Function                | Checks `noCooldown`? | Checks `noChallenge`? |
|-------------------------|----------------------|-----------------------|
| `withdrawCollateral()`  | **Yes** — owner blocked | Yes                |
| `forceSale()` (via `buyExpiredCollateral`) | **No** — third parties not blocked | Yes |
| `repay()`               | No                   | No                    |
| `mint()`                | Yes                  | Yes                   |

After expiration, `buyExpiredCollateral()` operates via `forceSale()` which does **not** check cooldown. External buyers can purchase collateral at declining auction prices while the position owner remains locked out by cooldown. The `buyExpiredCollateral` mechanism was designed to give owners time to act (starting at 10× virtual price), but the cooldown negates this protection.

---

## Attack Scenario (pre-fix)

### Prerequisites
- Any open position with collateral
- Attacker needs the minimum challenge amount (e.g., 0.002 WCBTC) as temporary working capital
- No JUSD required

### Cooldown Lock (repeatable daily)

```
Block N:   attacker calls challenge(position, 0.002 BTC, 0)
           → 0.002 BTC deposited to Hub
           → challengedAmount += 0.002

Block N+1: attacker calls bid(challengeNumber, 0.002 BTC, false)
           → msg.sender == challenger → 0 JUSD cost
           → 0.002 BTC returned to attacker
           → notifyChallengeAverted → cooldown = now + 1 day
           → challengedAmount = 0
```

**Cost per cycle:** ~$0.01 gas
**Effect per cycle:** Position owner blocked from withdrawing for 1 day

### Continuous Lockout via Overlap

The attacker alternates active challenges and cooldowns so the owner **never** has a window where both `challengedAmount == 0` and `cooldown` has expired:

```
T+0h:  challenge  → challengedAmount > 0 (noChallenge blocks withdrawal)
T+23h: self-avert → challengedAmount = 0, cooldown = T+24h (noCooldown blocks withdrawal)
T+23h: challenge  → challengedAmount > 0 (noChallenge blocks withdrawal)
T+47h: self-avert → challengedAmount = 0, cooldown = T+48h (noCooldown blocks withdrawal)
...repeat...
```

### Forced Sale at Expiration (pre-fix)

When the position expires while the owner is locked out:

1. `notifyChallengeStarted` has `alive` modifier → no new challenges possible after expiration
2. Last cooldown extends ~1 day past expiration
3. `buyExpiredCollateral()` becomes active immediately (no cooldown check)
4. Auction price declines from 10× to 1× virtual price over 24 hours, then to 0 over another 24 hours
5. By the time cooldown expires (~hour 24), the auction price has dropped to 1× virtual price

**Example (4.545 WCBTC, BTC = $100,000, liqPrice = $50,000):**

| Time after expiration | Auction price/BTC | Owner can withdraw? | Buyer profitable? |
|-----------------------|-------------------|---------------------|-------------------|
| Hour 0                | $545,000 (10×)    | No (cooldown)       | No                |
| Hour 12               | $300,000          | No (cooldown)       | No                |
| Hour 22               | $100,000          | No (cooldown)       | Break-even        |
| Hour 23               | $77,000           | No (cooldown)       | +$23k/BTC         |
| Hour 24               | $54,500 (1×)      | Cooldown ends       | +$45.5k/BTC       |

A rational buyer purchases when the auction price drops below market while the owner is still locked out.

**Financial impact:**

```
Owner's collateral at market:          $454,500  (4.545 BTC × $100,000)
Debt repayment:                       -$198,326  (interest + net principal)
Owner SHOULD receive:                  $256,174

Forced sale at ~1× virtual price:      $247,907  (4.545 BTC × $54,545)
After debt + fees, owner receives:      ~$49,581

LOSS DUE TO GRIEFING:                 ~$206,593  (80.6% of net equity)
```

### Attack Economics

| Metric                     | Value                         |
|----------------------------|-------------------------------|
| Attack cost (273 days)     | ~$3 total gas                 |
| Capital required           | 0.002 BTC (temporary, returned each cycle) |
| JUSD required              | 0                             |
| Owner loss (BTC @ $100k)   | ~$206,593                     |

---

## Fix

**Branch:** `fix/allow-debt-free-withdrawal`
**PR:** [#95](https://github.com/JuiceDollar/smartContracts/pull/95)

Replace the `noCooldown` modifier on `_withdrawCollateral` and `_withdrawCollateralAsNative` with an inline check that only enforces cooldown when there is outstanding debt.

### Position.sol — `_withdrawCollateral`

```diff
- function _withdrawCollateral(address target, uint256 amount) internal noCooldown noChallenge returns (uint256) {
+ function _withdrawCollateral(address target, uint256 amount) internal noChallenge returns (uint256) {
+     if (_getDebt() > 0) {
+         if (block.timestamp <= cooldown) revert Hot();
+     }
      uint256 balance = _sendCollateral(target, amount);
      _checkCollateral(balance, price);
      return balance;
  }
```

Same change applied to `_withdrawCollateralAsNative`.

### What remains unchanged

| Function | Modifier | Reason |
|---|---|---|
| `_mint()` | `noCooldown` stays | Prevents minting at overvalued prices during cooldown |
| `assertCloneable()` | `noCooldown` stays | Prevents cloning at overvalued prices during cooldown |
| `_adjustPrice()` | Direct cooldown check stays | Prevents price manipulation during cooldown |
| `notifyChallengeAverted` | `_restrictMinting(1 days)` stays | Cooldown still protects minting and cloning |
| `notifyChallengeSucceeded` | `_restrictMinting(3 days)` stays | Real liquidation event, cooldown justified |

### Why this is safe

1. **No minting risk:** `_mint()` retains its own `noCooldown` check — owner cannot repay, withdraw, and re-mint to circumvent cooldown
2. **No collateral risk:** `_checkCollateral` passes trivially when debt is 0 (collateral requirement = 0)
3. **No challenge interference:** `noChallenge` modifier remains on withdrawal — owner can only withdraw when `challengedAmount == 0`
4. **No cloning risk:** `assertCloneable()` retains `noCooldown` — positions cannot be cloned during cooldown regardless of debt state
5. **No price manipulation risk:** `_adjustPrice()` retains its cooldown check — price increases remain restricted

### Owner recovery path (post-fix)

1. `repay()` — always available, even during cooldown and active challenges
2. Wait for active challenge to resolve (averted or succeeded) → `challengedAmount = 0`
3. `withdrawCollateral()` — now available immediately when debt = 0 and no active challenge
4. Or atomically via `adjust(0, 0, currentPrice, false)` — repays debt and withdraws collateral in a single transaction

The overlap attack no longer works against debt-free owners: after any self-avert, `challengedAmount = 0` and `debt = 0` → cooldown is bypassed → owner withdraws before the attacker can start a new challenge.

---

## Historical Context

In the original Frankencoin V1 implementation, `challengeData()` capped Phase 1 duration at the time remaining until expiration:

```solidity
// V1
function challengeData(uint256 challengeStart) external view returns (uint256 liqPrice, uint64 phase1, uint64 phase2) {
    uint256 timeToExpiration = challengeStart >= expiration ? 0 : expiration - challengeStart;
    return (price, uint64(_min(timeToExpiration, challengePeriod)), challengePeriod);
}
```

After expiration, `phase1 = 0` — challenges went directly to Phase 2 (Dutch auction), where the market determined the fair price and surplus went to the owner. This provided a natural, fair liquidation mechanism for expired positions.

In V3, this was replaced by a fixed phase duration and the `buyExpiredCollateral()` mechanism:

```solidity
// V3
function challengeData() external view returns (uint256 liqPrice, uint40 phase) {
    return (_virtualPrice(_collateralBalance(), price), challengePeriod);
}
```

Phase 1 no longer respects expiration, and `buyExpiredCollateral` uses `virtualPrice` (derived from liquidation price) rather than market-driven price discovery. While `buyExpiredCollateral` was designed as a pro-owner improvement (10× starting price gives time to act), the cooldown on withdrawal negates this benefit.

---

## Proof of Concept

Observable on Citrea mainnet at position `0x125182C61Aa78f64E4a7c0dce8932b0f72E7a247`:

- **2026-04-28 18:34:31 UTC:** Challenge #2 started by `0x0C83d9336fED...` with 0.002 WCBTC
  - TX: `0xb9b4aa1517f49b589a8b2666708c484ae792369cea1a821e2087ceee0de0bd64`
- **2026-04-28 19:35:57 UTC:** Challenge averted by `0x7813e6CfA356...` (third-party aversion)
  - TX: `0xf075a19915f8295c4dcefb4c07876a546e3cd4c1cfade25ce6d5f6af50c551d7`
  - Cooldown set to 2026-04-29 19:35:57 UTC
  - Position owner blocked from withdrawing 4.545 WCBTC (~$347,000)

Note: This observed case was a third-party aversion (not a self-avert). The vulnerability is more severe with self-avert because the attacker pays zero JUSD and can repeat indefinitely at negligible cost.

Position state at time of discovery:
- Health ratio: 0.984 (technically undercollateralized due to accrued interest)
- Owner wallet: 0 JUSD, 0 WCBTC, 0 JUICE
- Interest accruing at ~50 JUSD/day with no repayment activity since creation (2026-02-28)

---

## Timeline

| Date       | Event                                                     |
|------------|-----------------------------------------------------------|
| 2026-01-26 | Position original deployed on Citrea mainnet              |
| 2026-02-28 | Clone `0x1251...` created with 4.545 WCBTC, 227,227 JUSD |
| 2026-04-28 | Challenge #2 observed, cooldown set on position           |
| 2026-04-29 | Vulnerability analyzed and documented                     |
| 2026-04-30 | Fix implemented ([PR #95](https://github.com/JuiceDollar/smartContracts/pull/95)) |
| 2027-01-26 | Position expiration (if unresolved)                       |
