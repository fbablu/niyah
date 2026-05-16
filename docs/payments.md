# Payments & Payouts

> Stripe integration, payout formulas, and settlement models.
> See also: [Features](./features.md) | [Roadmap](./roadmap.md) | [Legal](./legal.md)

## Stripe Integration

### Client

- `@stripe/stripe-react-native` -- PaymentSheet for deposits
- Publishable key via `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` env var

### Cloud Functions (24 deployed)

| Function                  | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `createPaymentIntent`     | Create Stripe PaymentIntent for deposits          |
| `verifyAndCreditDeposit`  | Verify payment succeeded, credit user's wallet    |
| `createConnectAccount`    | Create Stripe Connect Express account for payouts |
| `createAccountLink`       | Generate onboarding URL for Stripe Connect KYC    |
| `getConnectAccountStatus` | Check if Connect account is verified              |
| `requestWithdrawal`       | Initiate Stripe payout to Connect account         |
| `handleSessionComplete`   | Process completion, calculate payout              |
| `handleSessionForfeit`    | Process surrender, deduct stake                   |
| `distributeGroupPayouts`  | Calculate and distribute group session pool       |
| `stripeWebhook`           | Handle Stripe webhook events                      |

### Screens

- `app/session/deposit.tsx` -- deposit funds via Stripe PaymentSheet
- `app/session/withdraw.tsx` -- withdraw to connected bank account
- `app/session/stripe-onboarding.tsx` -- Stripe Connect KYC flow

### Current State (May 2026)

- Client library integrated, Cloud Functions deployed with **live keys** (Stripe + Plaid production)
- Live Stripe keys + webhook in Firebase Secret Manager; Plaid production credentials deployed
- Cloud Function calls bypassed only when `DEMO_MODE=true` (env-var driven; demo builds skip CF + use virtual balances)
- Redirect URLs in `createAccountLink` use `process.env.GCLOUD_PROJECT` (dynamic)
- App Check moving from soft-fail to enforce in [post-demo Lane A2](./post-demo-roadmap.md#lane-a--auth-identity-profile-keyboard-3-days)

## Bank Management

Two-stage flow: Plaid Link for bank discovery + Stripe Connect for payout rail. Both server-mediated; no bank credentials touch the client.

### Linking flow (today)

1. Client calls `createPlaidLinkToken` → Plaid hosted Link opens natively.
2. On success, client posts `{ publicToken, accountId }` to `linkBankAccount`.
3. Server exchanges public_token, creates Stripe external account, stores `plaidAccessToken` + `plaidItemId` + `linkedBank` (`institutionName` / `bankName` / `mask` / `linkedAt`) under `users/{uid}`.

### Replace / unlink (post-demo Lane D1+D2)

The "Connect Different Bank" button currently only re-runs link, leaving the prior Stripe external account attached. The new flow:

| CF | Behavior |
| --- | --- |
| `unlinkBankAccount` | Detach the Stripe external account, clear `users/{uid}.linkedBank`, `plaidAccessToken`, `plaidItemId`, `plaidAccountId`. Idempotent — safe to call on already-unlinked users. Sentry breadcrumb per step. |
| `replaceBankAccount` | Single-transaction unlink + new Plaid Link result. Old token is revoked **only after** the new external account validates, so a failed replace falls back to the prior bank. |

Profile UI gets a `Manage Bank` action sheet (Lane D3): Replace / Remove. Remove confirms then calls `unlinkBankAccount`.

## Solo Payout Structure

### Current Model (stickK)

| Cadence | Stake | Payout on Complete    | On Forfeit      |
| ------- | ----- | --------------------- | --------------- |
| Daily   | $5    | $5 (stake returned)   | $0 (lose stake) |
| Weekly  | $25   | $25 (stake returned)  | $0              |
| Monthly | $100  | $100 (stake returned) | $0              |

### Implemented Algorithm (not yet wired)

`src/utils/payoutAlgorithm.ts` has a 2x multiplier model:

| Cadence | Stake | Payout (2x) | ROI  |
| ------- | ----- | ----------- | ---- |
| Daily   | $5    | $10         | 2x   |
| Weekly  | $25   | $60         | 2.4x |
| Monthly | $100  | $260        | 2.6x |

**Reconciliation needed**: `sessionStore.ts` uses stickK (1x return), `payoutAlgorithm.ts` implements the 2x multiplier (`SOLO_COMPLETION_MULTIPLIER`), and the two paths produce different values on the same input. Resolved as an open question on the [post-demo plan](./post-demo-roadmap.md#open-items-needing-user-input-post-approval); both paths stay until the call is made.

## Wallet Reconciliation

Single integer `wallets/{uid}.balance` field in cents (plus `pendingBalance`) is the source of truth for in-app spending and withdrawal eligibility. All increments use Firestore `FieldValue.increment` inside a transaction, gated by a `payoutsSettledAt` timestamp so a retry cannot double-credit.

### Drift detection (post-demo Lane D5)

Nightly scheduled CF `reconcileWalletBalances`:

1. For each `wallets/{uid}`: sum every entry in `transactions` where `userId == uid`.
2. Compare to `wallets/{uid}.balance`.
3. Mismatch → write a record to `walletAudits/{uid}_{date}` (`expected`, `actual`, `delta`, `lastTransactionId`).
4. Sentry alert if `|delta| > 0`.

### Idempotency on payouts and withdrawals

All `stripe.transfers.create` calls pass an idempotency key:

| Flow | Key |
| --- | --- |
| Group session payout | `group_session_payout:${sessionId}:${userId}:${amount}` |
| Solo session payout  | `solo_session_payout:${sessionId}:${userId}:${amount}` |
| Withdrawal           | `withdrawal:${userId}:${requestedAtMs}:${amount}:${method}` |

A retried call returns the same transfer instead of double-paying. Verified by integration test `functions/test/withdraw-earned.test.ts` (post-demo Lane D7).

## Group Payout Formula

Screen-time-weighted pool distribution:

```
Let c = equal contribution from each person
Let t_i = screen time for person i (on selected distraction apps)
Let t_max = maximum time in the group
Let t_bar = mean time of the group

Payout for person i:
  P_i = c                                    if t_max = t_bar (everyone equal)
  P_i = c * (t_max - t_i) / (t_max - t_bar)  otherwise
```

Lower screen time = higher payout. Uses greedy transfer netting to minimize the number of peer-to-peer transfers.

**Subject to legal review** for gambling risk. See [Legal](./legal.md#poolduo-mode----higher-risk).

### Streak Multipliers (Future)

| Cadence | Milestone 1 | Milestone 2 |
| ------- | ----------- | ----------- |
| Daily   | 1.25x @ 5d  | 1.5x @ 10d  |
| Weekly  | 1.5x @ 4wk  | 2x @ 8wk    |
| Monthly | 2x @ 3mo    | 3x @ 6mo    |

## Settlement Models by Phase

| Phase   | Model         | How it works                                                                                |
| ------- | ------------- | ------------------------------------------------------------------------------------------- |
| Phase 1 | Honor-based   | Virtual balances in-app, Venmo deep links for real settlement, reputation tracking          |
| Phase 2 | Stripe escrow | Collect real stakes upfront via PaymentIntent, auto-distribute via `distributeGroupPayouts` |
| Phase 3 | Production    | Stripe live mode, full compliance                                                           |

### Group Session Firestore Schema (Phase 1 Backend)

```
groupSessions/{sessionId}
  hostUid: string
  participantUids: string[]
  status: "proposed" | "ready" | "active" | "completed" | "cancelled"
  stakeAmount: number (cents, flexible)
  durationMs: number (flexible)
  scheduledStart: Timestamp | null
  startedAt: Timestamp | null
  completedAt: Timestamp | null
  results: { [uid]: { completed: boolean, screenTimeMs?: number } }
  payouts: { [uid]: number }
  transfers: Transfer[]

groupInvites/{inviteId}
  sessionId: string
  inviteeUid: string
  inviterUid: string
  stakeAmount: number
  durationMs: number
  status: "pending" | "accepted" | "declined"
  createdAt: Timestamp
```
