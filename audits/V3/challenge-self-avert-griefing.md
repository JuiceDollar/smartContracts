# JUSD-2026-001: Cooldown Blocks Debt-Free Collateral Withdrawal

| Field              | Value                                                    |
|--------------------|----------------------------------------------------------|
| **Severity**       | High                                                     |
| **Type**           | Griefing / Denial of Service                             |
| **Component**      | Position (V3)                                            |
| **Status**         | Fixed (`fix/allow-debt-free-withdrawal`)                  |
| **Date Reported**  | 2026-04-29                                               |
| **Affected Files** | `MintingHubV3/Position.sol`                              |
| **Origin**         | Inherited from Frankencoin / d-EURO fork                 |

---

## Summary

The `withdrawCollateral()` function unconditionally checks the `noCooldown` modifier, even when the position has zero debt. This allows an attacker to lock a position owner out of their collateral at near-zero cost by repeatedly creating challenges and immediately self-averting them. Each self-avert costs only gas but imposes a 1-day cooldown, blocking `withdrawCollateral()`.

Position owners who have fully repaid their debt should be able to withdraw their collateral immediately, since all protective purposes of the cooldown (preventing minting, allowing re-challenges) are irrelevant when there is no outstanding debt.

---

## Root Cause

### 1. Free Self-Avert (MintingHub.sol, `_avertChallenge`)

```solidity
if (msg.sender == _challenge.challenger) {
    // allow challenger to cancel challenge without paying themselves
} else {
    JUSD.transferFrom(msg.sender, _challenge.challenger, (size * liqPrice) / (10 ** 18));
}

_challenge.position.notifyChallengeAverted(size);  // <-- always called
```

When the challenger bids on their own challenge, no JUSD payment is required. The challenger's collateral is returned in full. Net cost: only gas.

### 2. Unconditional Cooldown (Position.sol, `notifyChallengeAverted`)

```solidity
function notifyChallengeAverted(uint256 size) external onlyHub {
    challengedAmount -= size;
    _restrictMinting(1 days);  // <-- always sets 1-day cooldown
}
```

Every aversion — including a free self-cancellation — triggers a 1-day cooldown that blocks `withdrawCollateral()` via the `noCooldown` modifier.

### 3. Cooldown Applied Regardless of Debt State

```solidity
function _withdrawCollateral(...) internal noCooldown noChallenge returns (uint256) {
```

The `noCooldown` modifier blocks withdrawal even when the position has zero debt. At that point, the cooldown serves no protective purpose:
- **Minting** is irrelevant (nothing to mint against with zero debt)
- **Re-challenges** are irrelevant (nothing to liquidate)
- **`_checkCollateral`** passes trivially (requirement = 0)

### 4. Asymmetry with `forceSale`

| Function                | Checks `noCooldown`? | Checks `noChallenge`? |
|-------------------------|----------------------|-----------------------|
| `withdrawCollateral()`  | **Yes** — blocked    | Yes                   |
| `forceSale()` (via `buyExpiredCollateral`) | **No** — not blocked | Yes        |
| `repay()`               | No                   | No                    |
| `mint()`                | Yes                  | Yes                   |

After expiration, `buyExpiredCollateral()` operates via `forceSale()` which does **not** check cooldown. External buyers can purchase collateral at declining auction prices while the position owner remains locked out.

---

## Attack Scenario

### Prerequisites
- Any open position with collateral (e.g., 4.545 WCBTC, ~$454,500 at $100k BTC)
- Attacker needs 0.002 BTC (minimum challenge size) as temporary working capital
- No JUSD required

### Execution

**Cooldown Lock (repeatable daily)**

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

**Cost per cycle:** ~$0.01 gas (two transactions on Citrea L2)
**Effect per cycle:** Position owner blocked from withdrawing for 1 day

**Overlap strategy for continuous lockout:**

```
T+0h:  challenge  → challengedAmount > 0 (noChallenge blocks)
T+23h: self-avert → challengedAmount = 0, cooldown = T+24h (noCooldown blocks)
T+23h: challenge  → challengedAmount > 0 (noChallenge blocks)
T+47h: self-avert → challengedAmount = 0, cooldown = T+48h (noCooldown blocks)
...repeat...
```

At no point can the owner call `withdrawCollateral()`.

**Forced Sale at Expiration**

When the position expires:
1. `notifyChallengeStarted` has `alive` modifier → no new challenges possible
2. Last cooldown extends ~1 day past expiration
3. `buyExpiredCollateral()` becomes active immediately at expiration
4. Auction price declines: 10× → 1× virtual price over 24 hours
5. At cooldown expiry (~hour 24), auction price reaches 1× virtual price

**Concrete numbers (BTC = $100,000, position liqPrice = $50,000):**

| Time after expiration | Auction price/BTC | Owner can withdraw? | Buyer profitable? |
|-----------------------|-------------------|---------------------|-------------------|
| Hour 0                | $545,000 (10×)    | No (cooldown)       | No                |
| Hour 12               | $300,000          | No (cooldown)       | No                |
| Hour 22               | $100,000          | No (cooldown)       | **Break-even**    |
| Hour 23               | $77,000           | No (cooldown)       | **+$23k/BTC**     |
| Hour 24               | $54,500 (1×)      | Yes (cooldown ends) | **+$45.5k/BTC**   |

### Attack Economics

| Metric                     | Value                         |
|----------------------------|-------------------------------|
| Attack cost (273 days)     | ~$3 total gas                 |
| Capital required           | 0.002 BTC (temporary, returned each cycle) |
| JUSD required              | 0                             |
| Owner loss (BTC @ $100k)   | ~$206,593                     |
| Profit ratio               | ~69,000:1                     |

---

## Impact

### Position Owner
- Cannot withdraw collateral despite being able to repay debt
- Forced into `buyExpiredCollateral` auction at below-market prices
- Even after full debt repayment, collateral is sold at virtual price (~$54.5k) instead of being returned at market value (~$100k)

### Scope
- Affects **any** open position on any collateral type
- The vulnerability is inherited from the Frankencoin/d-EURO design and may affect those protocols as well
- The `buyExpiredCollateral` mechanism was designed to give owners time to act (10× starting price), but the cooldown negates this protection

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
| `notifyChallengeAverted` | `_restrictMinting(1 days)` stays | Cooldown still needed for minting/cloning protection |
| `notifyChallengeSucceeded` | `_restrictMinting(3 days)` stays | Real liquidation event, cooldown justified |

### Why this is safe

1. **No minting risk:** Debt = 0 means there is nothing to mint against
2. **No collateral risk:** `_checkCollateral` passes trivially when collateral requirement is 0
3. **No challenge risk:** `noChallenge` modifier remains — withdrawal only when `challengedAmount == 0`
4. **No cloning risk:** `assertCloneable` still checks `noCooldown` — cloning remains blocked during cooldown
5. **No re-mint risk:** Owner cannot repay, withdraw, and re-mint — `_mint` still checks `noCooldown`

### Owner recovery path

1. `repay()` — always available, clears debt (even during cooldown and active challenges)
2. `withdrawCollateral()` — now available immediately when debt = 0 and no active challenge
3. Or atomically via `adjust(0, 0, price, false)` — repays and withdraws in a single transaction

---

## Proof of Concept

Observable on Citrea mainnet at position `0x125182C61Aa78f64E4a7c0dce8932b0f72E7a247`:

- **2026-04-28 18:34:31 UTC:** Challenge #2 started by `0x0C83d9336fED...` with 0.002 WCBTC
  - TX: `0xb9b4aa1517f49b589a8b2666708c484ae792369cea1a821e2087ceee0de0bd64`
- **2026-04-28 19:35:57 UTC:** Challenge averted by `0x7813e6CfA356...`
  - TX: `0xf075a19915f8295c4dcefb4c07876a546e3cd4c1cfade25ce6d5f6af50c551d7`
  - Cooldown set to 2026-04-29 19:35:57 UTC
  - Position owner blocked from withdrawing 4.545 WCBTC (~$347,000)

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
| 2026-04-30 | Fix implemented (`fix/allow-debt-free-withdrawal`)        |
| 2027-01-26 | Position expiration (if unresolved)                       |
