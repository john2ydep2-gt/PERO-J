# Oracle & Dispute Resolution: Bond Requirements, Challenge Windows, and Slashing Rules

## 1. Overview

This document specifies the economic security parameters governing oracle submissions, event verifications, and dispute resolutions within the PERO-J platform.

To deter dishonest data submissions and malicious disputes, PERO-J enforces an optimistic verification model backed by:
- **Bond Deposit Requirements**: Collateral staked by submitters and disputers.
- **Deterministic Challenge Windows**: Explicit ledger-based timeframes during which submitted data may be audited and disputed.
- **Slashing & Redistribution Rules**: Game-theoretic financial penalties that slash malicious actors while compensating verifiers and jurors.

---

## 2. Bond Deposit Requirements

All participants proposing oracle outcomes or challenging state transitions must lock collateral (bonds).

### 2.1 Submitter Bond
- **Base Bond**: `1,000 PERO` (or equivalent in XLM).
- **Dynamic Liquidity Scaling**: High-volume contracts require a bond scaling linearly with Total Value Locked (TVL) or disputed amount:
  $$\text{Required Bond} = \max\left(1000, \frac{\text{TVL} \times \text{Risk Factor}}{10,000}\right)$$
- **Escrow**: Bonds are locked in the smart contract escrow during the entirety of the challenge window.
- **Release**: If no challenge is filed before the challenge window lapses, the bond is returned in full along with any protocol rewards.

### 2.2 Challenger Bond
- Challengers must deposit a bond matching `100%` of the submitter's posted bond to file an official challenge.
- Prevents denial-of-service and griefing challenges.

---

## 3. Challenge Windows

The challenge window is the window of time (measured in ledger blocks) during which any network participant can review evidence and file an on-chain dispute.

| Submission Category | Challenge Window (Ledgers) | Duration (~Approx) | Finality Condition |
| :--- | :--- | :--- | :--- |
| **Standard Event Log** | 43,200 ledgers | ~72 hours | Automatic finality if unchallenged |
| **High-Stakes Oracle** | 100,800 ledgers | ~7 days | Multi-party audit review |
| **Critical Settlement** | 201,600 ledgers | ~14 days | DAO committee confirmation |

### State Transition Lifecycle

```
[ Submitted ] ---> (Within Challenge Window: No Challenge) ---> [ Finalized ]
      |                                                            (Bond Returned)
      +----------> (Challenge Filed + Matching Bond) ---------> [ Under Dispute ]
                                                                       |
                                                                       v
                                                                [ Juror Voting ]
                                                                       |
                                                                [ Resolution ]
```

---

## 4. Slashing Rules & Penalties

When a dispute resolves, stakes are settled according to deterministic rules:

### 4.1 Malicious Submitter (Dispute Upheld)
- Submitter's entire bond is slashed (100%).
- **Challenger Reward**: `50%` of the slashed bond is awarded to the successful challenger.
- **Juror Pool**: `20%` is distributed pro-rata to jurors who voted with the majority.
- **Protocol Treasury**: `30%` is directed to the community treasury reserve.

### 4.2 Frivolous Challenger (Dispute Rejected)
- Challenger's entire bond is slashed (100%).
- **Submitter Compensation**: `50%` awarded to the submitter for delay and inconvenience.
- **Juror Pool**: `20%` distributed to jurors.
- **Treasury**: `30%` directed to treasury.

---

## 5. Appeals & Governance Escalation

- An appeal can be lodged within `17,280 ledgers` (~24 hours) after the initial dispute verdict.
- Lodging an appeal requires a bond multiplier of `2.0x`.
- Appeals escalate to the full DAO governance juror pool.
