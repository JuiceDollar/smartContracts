# JUSD-2026-001: Challenge Self-Avert Griefing

| Field              | Value                                                    |
|--------------------|----------------------------------------------------------|
| **Severity**       | High                                                     |
| **Type**           | Griefing / Denial of Service                             |
| **Component**      | MintingHub (V3) + Position                               |
| **Status**         | Fixed (`fix/challenge-self-avert-griefing`)               |
| **Date Reported**  | 2026-04-29                                               |
| **Affected Files** | `MintingHubV3/MintingHub.sol`, `MintingHubV3/Position.sol` |
| **Origin**         | Inherited from Frankencoin / d-EURO fork                 |

---

## Summary

An attacker can lock a position owner out of their collateral indefinitely at near-zero cost by repeatedly creating challenges and immediately self-averting them. Each self-avert costs only gas but imposes a 1-day cooldown on the position, blocking `withdrawCollateral()`. When timed near position expiration, this forces the collateral into the `buyExpiredCollateral()` Dutch auction where it sells at the virtual price — potentially far below market value — causing significant financial loss to the position owner.

---

## Root Cause

Two code paths interact to create the vulnerability:

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

Every aversion — including a free self-cancellation — triggers a 1-day cooldown that blocks both `withdrawCollateral()` and `mint()` via the `noCooldown` modifier.

### 3. Asymmetry After Expiration

| Function                | Checks `noCooldown`? | Checks `noChallenge`? |
|-------------------------|----------------------|-----------------------|
| `withdrawCollateral()`  | **Yes** — blocked    | Yes                   |
| `forceSale()` (via `buyExpiredCollateral`) | **No** — not blocked | Yes        |
| `repay()`               | No                   | No                    |
| `mint()`                | Yes                  | Yes                   |

After expiration, `buyExpiredCollateral()` operates via `forceSale()` which does **not** check cooldown. External buyers can purchase collateral at declining auction prices while the position owner remains locked out by cooldown.

---

## Attack Scenario

### Prerequisites
- Any open position with collateral (e.g., 4.545 WCBTC, ~$454,500 at $100k BTC)
- Attacker needs 0.002 BTC (minimum challenge size) as temporary working capital
- No JUSD required

### Execution

**Phase 1: Cooldown Lock (repeatable daily)**

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

The attacker can ensure the owner **never** has a window where both `challengedAmount == 0` and `cooldown < block.timestamp`:

```
T+0h:  challenge  → challengedAmount > 0 (noChallenge blocks)
T+23h: self-avert → challengedAmount = 0, cooldown = T+24h (noCooldown blocks)
T+23h: challenge  → challengedAmount > 0 (noChallenge blocks)
T+47h: self-avert → challengedAmount = 0, cooldown = T+48h (noCooldown blocks)
...repeat...
```

At no point can the owner call `withdrawCollateral()`.

**Phase 2: Forced Sale at Expiration**

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

A rational buyer purchases at hour ~23-24 when profit is maximized and the owner is still locked.

**Financial impact:**

```
Owner's collateral value at market:     $454,500  (4.545 BTC × $100,000)
Debt repayment cost:                   -$198,326  (interest + net principal)
Owner SHOULD receive:                   $256,174

Forced sale at 1× virtual price:        $247,907  (4.545 BTC × $54,545)
After debt repayment, owner receives:    $49,581

LOSS DUE TO GRIEFING:                  $206,593  (80.6% of net equity)
```

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
- Even after full debt repayment (`repay()` works during cooldown), collateral is sold at virtual price (~$54.5k) instead of being returned at market value (~$100k)

### System
- If the collateral sells at very low prices (hour 36-48), `coverLoss()` drains equity and minter reserve
- With system equity of ~$20k and minter reserve of ~$63k, a single large position loss (~$243k) would exceed the entire system buffer
- Potential de-peg cascade for all JUSD holders

### Scope
- Affects **any** open position on any collateral type
- Lower collateralization ratio (higher debt relative to collateral) increases vulnerability
- The vulnerability is inherited from the Frankencoin/d-EURO design and may affect those protocols as well

---

## Fix

**Branch:** `fix/challenge-self-avert-griefing`

The fix distinguishes between a **self-cancellation** (challenger cancels their own challenge) and a **genuine third-party aversion** (a market participant averts the challenge by paying the challenger).

### MintingHub.sol — `_avertChallenge`

```diff
  if (msg.sender == _challenge.challenger) {
-     // allow challenger to cancel challenge without paying themselves
+     // Self-cancellation: no payment, no cooldown on the position.
+     _challenge.position.notifyChallengeCancelled(size);
  } else {
      JUSD.transferFrom(msg.sender, _challenge.challenger, (size * liqPrice) / (10 ** 18));
+     _challenge.position.notifyChallengeAverted(size);
  }
-
- _challenge.position.notifyChallengeAverted(size);
```

### Position.sol — new `notifyChallengeCancelled`

```solidity
function notifyChallengeCancelled(uint256 size) external onlyHub {
    challengedAmount -= size;
    // No _restrictMinting — self-cancellation carries no market signal
}
```

### IPosition.sol — interface

```diff
  function notifyChallengeAverted(uint256 size) external;
+ function notifyChallengeCancelled(uint256 size) external;
```

### Rationale

- **Self-avert = cancellation:** The challenger is withdrawing their own challenge. No economic activity occurred. No market signal was given. No reason to restrict the position owner.
- **Third-party avert = market signal:** Someone paid JUSD at the virtual price to acquire the challenger's collateral. This is a real economic action that validates (or questions) the position's pricing. The 1-day cooldown remains appropriate to allow re-challenges.
- **Minimal change:** 3 files modified, 1 new function added. No changes to modifiers, `_restrictMinting`, `forceSale`, or `buyExpiredCollateral`. All existing tests pass (465/465).

### Residual Risk

A two-address variant remains possible: the attacker challenges from address A and averts from address B (triggering the third-party path with cooldown). This requires the attacker to cycle `virtualPrice × challengeSize` in JUSD between addresses (e.g., ~101 JUSD for a 0.002 BTC challenge at $50k virtual price). While not free, it is cheap. The cost and complexity are significantly higher than the zero-cost self-avert, making sustained griefing economically unattractive, but not impossible.

---

## Proof of Concept

Observable on Citrea mainnet at position `0x125182C61Aa78f64E4a7c0dce8932b0f72E7a247`:

- **2026-04-28 18:34:31 UTC:** Challenge #2 started by `0x0C83d9336fED...` with 0.002 WCBTC
  - TX: `0xb9b4aa1517f49b589a8b2666708c484ae792369cea1a821e2087ceee0de0bd64`
- **2026-04-28 19:35:57 UTC:** Challenge averted by `0x7813e6CfA356...` (third-party, not self-avert in this case)
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
| 2026-04-30 | Fix implemented and pushed                                |
| 2027-01-26 | Position expiration (if unresolved)                       |
