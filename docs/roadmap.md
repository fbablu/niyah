# Roadmap

> Development phases, current status, and blockers.
> See also: [Features](./features.md) | [Payments](./payments.md) | [Native Modules](./native-modules.md)
>
> **Active plan:** [Post-Demo Stabilization & Premium UX](./post-demo-roadmap.md) — 4 parallel swimlanes covering all 11 issues from TestFlight 1.0.0 (11) testing on May 5, 2026.

## Current Status (May 13, 2026)

| Area                     | Status     | Notes                                                                           |
| ------------------------ | ---------- | ------------------------------------------------------------------------------- |
| Firebase Auth            | Done       | Google, Apple, Email magic link, Phone SMS OTP via RNFB                         |
| Firestore                | Done       | Profiles, wallets, follows, sessions. Crash recovery.                           |
| Solo Sessions (Backend)  | Done       | sessionStore + handleSessionComplete/Forfeit CFs. Full lifecycle.               |
| Solo Sessions (UI)       | Done       | Wired April 16-18; flexible-cadence solo flow live in TestFlight.               |
| Quick Block              | Done       | One-tap blocking without stake (`quick-block.tsx`)                              |
| Duo Sessions             | Done       | Partner store, lifecycle, Venmo deep links                                      |
| Group Sessions (UI)      | Done       | N-person, payout algorithm, transfer tracking, propose, waiting room, invites   |
| Group Sessions (Backend) | Done       | 7 Cloud Functions (create, invite, accept, start, report, cancel, auto-timeout) |
| Social Features          | Done       | Following/followers, public profiles, reputation (5 tiers)                      |
| Contact Discovery        | Done       | `findContactsOnNiyah` Cloud Function, cached in socialStore                     |
| Referral System          | Done       | Deep link invites, reputation boost, partner auto-connect                       |
| Theme System             | Done       | Dark/light via themeStore + useColors hook                                      |
| Onboarding               | Done       | Screen Time setup flow, blob scenes, profile setup                              |
| Testing                  | Done       | 1018 tests (48 suites), unit + integration coverage                             |
| Screen Time (Swift)      | Done       | Production-quality. Auth, picker, blocking, violation polling, custom shield.   |
| Screen Time (Shield)     | Done       | Custom Niyah-branded shield with "Stay Focused" / "Surrender" buttons           |
| Screen Time (Wiring)     | Done       | Quick-block, solo staked, and group session flows all wired.                    |
| Screen Time (Stats)      | Phase 4    | DeviceActivityReport extension scoped in [post-demo plan](./post-demo-roadmap.md) Lane B1. |
| Schedule Blocking        | Phase 4    | scheduleStore, schedule-builder, calendar integration; reopens post-grad        |
| Push Notifications       | Done       | FCM token management, 9 notification types wired; foreground via notifee (Lane C5). |
| Stripe Payments          | Done       | Live keys deployed, 24 Cloud Functions, deposit/withdrawal/Connect/Plaid.       |
| Legal Acceptance         | Done       | `acceptLegalTerms` Cloud Function, server-timestamped                           |
| Firestore Rules          | Done       | Hardened rules for users, wallets, follows, sessions. Default deny.             |
| Security Audit           | Done       | Server-side validation, rate limiting, SSL pinning, screen protection           |
| Firebase App Check       | In Progress | Soft-fail today; flipping to enforce on auth-related CFs in Lane A2.            |
| Config Externalized      | Done       | Firebase config gitignored, env vars, keys rotated                              |
| Payout Algorithm         | Done       | Solo 1x in store / 2x in algo (open — see post-demo open questions); group pool split + greedy transfers. |
| App Icon + Splash        | Done       | New pillow icon, green (#2D6A4F) splash screen                                  |
| Withdrawal Flow          | Done       | Stripe Express onboarding, polished UI, security disclaimer. Bank manage (replace/unlink) in Lane D. |
| Account Linking          | Phase 4    | Same-user, multi-provider linking via `linkWithCredential` (Lane A3).           |
| Live Activities          | Phase 4    | Lock-screen + Dynamic Island widget (Lane B6/B7).                               |
| Group Equity             | Phase 4    | Cap-target model verified by DeviceActivityReport (see [group-equity.md](./group-equity.md)). |

### Apple Developer Account

- [x] Apple Developer Program ($99) -- active
- [x] FamilyControls Development entitlement -- approved
- [x] FamilyControls Distribution entitlement -- approved 2026-04-09 for `com.niyah.app`
- [ ] FamilyControls Distribution for extensions -- submitted April 10, pending Apple review
  - `com.niyah.app.device-activity-monitor`
  - `com.niyah.app.shield-action`
  - `com.niyah.app.shield-config`
- [ ] FamilyControls Distribution for `com.niyah.app.device-activity-report` (new, Lane B1)

### Business & Payments (as of 2026-05-13)

- [x] Niyah, Inc. incorporated with EIN
- [x] Stripe live mode -- business account active, live API keys deployed to Firebase Secret Manager
- [x] Plaid production -- approved, pay-as-you-go ($1.50/initial Link call)
- [x] Live keys deployed to `.env` + Firebase Secret Manager (Stripe + Plaid)
- [x] Stripe production webhook endpoint configured
- [x] Landing page live at niyah.live

### Firebase Project

- [x] Firebase project with Auth + Firestore
- [x] 24 Cloud Functions deployed (Stripe, Plaid, session lifecycle, group sessions, social, legal, webhook)
- [x] Firestore security rules hardened and ready to deploy
- [x] Cloud Functions for group sessions (7 functions: create, invite, accept, start, report, cancel, auto-timeout)
- [x] FCM push notifications (9 notification types)

## Launch Strategy

**Positioning**: Financial stakes + social accountability for focus. NOT "cheaper Opal." Unique intersection of commitment contracts (stickK model) + OS-level app blocking (FamilyControls).

**Revenue model**: Free now, subscription later ($3-5/mo for analytics + schedules).

1. **Phase 1** -- ✅ Demo Day (April 15) + Final Presentation (April 16)
2. **Phase 2** -- ✅ Solo Sessions (April 16-18)
3. **Phase 3** -- ✅ Campus Launch "Lock In For Finals" (April 19 - May 5)
4. **Phase 4** -- 🚧 Premium UX Push (May 8 - June, in flight)
5. **Phase 5** -- Public Launch + Fundraise

## Phase 1: Demo Day (April 15-16) — ✅ Complete

Live demo shipped April 15; Immersion Showcase poster + station demo on April 16. Zero crashes during the run, real Stripe deposits and group payouts flowed live. Historical detail: [Sprint Plan](./sprint-april15.md).

## Phase 2: Solo Sessions (April 16-18) — ✅ Complete

Solo staked flow wired through select → confirm → active → complete/surrender. `sessionStore` is the source of truth for solo lifecycle; `handleSessionComplete` and `handleSessionForfeit` Cloud Functions handle settlement.

## Phase 3: Campus Launch (April 19 - May 5) — ✅ Complete

**"Lock In For Finals"** TestFlight cohort at Vanderbilt during finals.

- Posters/flyers with QR → TestFlight build 1.0.0 (11)
- Promo: "Complete 5 sessions with 2+ friends → earn $5 free" ($100 pool)
- FCM push (9 types), Sentry crash monitoring, analytics events live
- Outcomes (DAU, completion rate, avg stake, retention) being compiled — first cut of numbers will feed Phase 5 pitch deck. Need to record final numbers here once tallied.

May 5 user-testing on build 1.0.0 (11) surfaced 11 UX / reliability gaps that became Phase 4.

## Phase 4: Premium UX Push (May 8 - June) — 🚧 In Flight

Closes the 11 gaps from the May 5 TestFlight testing and lifts the app's polish for the post-graduation fundraise. Detailed plan: [post-demo-roadmap.md](./post-demo-roadmap.md). Four parallel swimlanes:

- **Lane A — Auth & Identity (3d)**. Phone OTP global throttle, App Check enforce on auth-related CFs, multi-provider account linking (`linkWithCredential`), `mergeDuplicateUsers` admin CF, profile-sync source-of-truth fix, global `react-native-keyboard-controller`.
- **Lane B — Native iOS (5d)**. New `NiyahDeviceActivityReport` extension (for usage baselines), new `NiyahLiveActivity` widget (lock-screen + Dynamic Island), redesigned app-selection onboarding, per-app shield variants, two-step shield surrender via push.
- **Lane C — Inline UX & Push (3d)**. `<StatusBanner>` replacing `Alert.alert` across group flow, YouTube-style scrubber timer with pause = surrender confirm, foreground push via notifee, 4 new in-session FCM types (`member_app_opened`, `leaderboard_shift`, `session_progress_*`, `surrender_confirm_pending`), optimistic group leaderboard.
- **Lane D — Bank & Payout Reliability (2d)**. `unlinkBankAccount` + `replaceBankAccount` CFs, profile "Manage Bank" UI, withdrawal availability indicator, nightly `reconcileWalletBalances` scheduled CF, idempotency keys on every `stripe.transfers.create`, Sentry breadcrumbs on the payout path, integration test for earned-funds withdrawal.

Lane E (doc refresh) is independent and runs anytime — that's this commit.

Open items still needing user decision:

1. Solo payout multiplier — 1x (stickK) vs 2x (`SOLO_COMPLETION_MULTIPLIER`). Today the two paths disagree.
2. Default `CAP_FACTOR` for the [cap-target equity model](./group-equity.md).
3. Frequency limit for `member_app_opened` push (30s cooldown vs higher).
4. Final Phase 3 outcome numbers for the status table above.

## Phase 5: Public Launch + Fundraise

- App Store public release
- Pitch deck with real campus metrics (DAU, retention, completion rate)
- Unit economics model (CAC, LTV, take rate from forfeited stakes)
- Competitive positioning deck
- Legal compliance review for additional states

## Blockers

| Blocker                                    | Impact                                                            | Resolution                                                             | Status             |
| ------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ |
| ~~FamilyControls Development entitlement~~ | ~~Cannot test Screen Time on device~~                             | ~~Apply in Apple Developer portal~~                                    | **Resolved**       |
| ~~FamilyControls Distribution (main app)~~ | ~~Cannot distribute via TestFlight/App Store~~                    | ~~Apple approved 2026-04-09~~                                          | **Resolved**       |
| FamilyControls Distribution (3 extensions) | Extensions may not work in TestFlight builds                      | Submit for `device-activity-monitor`, `shield-action`, `shield-config` | Submitted April 10 |
| FamilyControls Distribution (`device-activity-report`) | Needed for baseline + cap-target equity                | Submit when extension target lands (Lane B1)                           | Pending submit     |
| ~~Shield surrender desync bug~~            | ~~Shield unblocks apps but Niyah app still shows session active~~ | ~~Fixed: shield sets flag + opens app, JS listener catches it~~        | **Resolved**       |
| ~~Firebase App Check~~                     | ~~Anyone with project ID can call Cloud Functions~~               | ~~Soft-fail in prod; flipping to enforce in Lane A2~~                  | **In progress**    |
| ~~Stripe bank verification~~               | ~~Withdrawal demo may fail if micro-deposits not cleared~~        | ~~Resolved: live keys deployed, withdrawals running~~                  | **Resolved**       |
| Wallet balance drift                       | Edge-case retries could double-credit                             | Nightly `reconcileWalletBalances` + idempotency keys (Lane D5)         | In progress        |
