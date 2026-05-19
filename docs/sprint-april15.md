> **Historical — Sprint complete.** Demo Day landed April 15, 2026 and the April 16 Immersion Showcase shipped on schedule. Active post-demo work is tracked in [post-demo-roadmap.md](./post-demo-roadmap.md); top-level phase view in [roadmap.md](./roadmap.md). Kept here for reference.

# Niyah: Demo Day Sprint (Updated April 12, 2026)

## DEMO DAY: April 15, 2026

**Format**: Live phone demo in front of class.
**Final Presentation**: April 16, 2026 (Immersion Showcase — poster + live demo at station).
**Goal**: Zero crashes, real money flowing, polished E2E demo.

### Demo Script (5-7 min)

1. Open app → clean dashboard, real balance visible
2. Quick Block → one tap → show apps blocked → custom Niyah shield → end
3. Deposit $5 via live Stripe → balance updates in real time
4. Group Challenge → invite teammate → both join waiting room → session starts
5. Open Instagram → custom Niyah shield appears → "Stay Focused" button
6. Timer completes → confetti → payout breakdown
7. Show withdrawal screen → initiate withdrawal (or explain 1-2 day bank processing)

### What Was Cut for Demo

- Schedule-based blocking (scheduleStore, schedule-builder) — post-demo
- Calendar integration — post-demo
- DeviceActivityReport chart — post-demo
- Threshold nudges — post-demo
- Solo staked sessions — building post-demo (April 16-18) for campus launch
- Firebase App Check — post-demo (requires native rebuild, too risky before demo)

---

## PHASE 0: DEMO STABILIZATION (April 12-14)

### Priority 1: Deploy Cloud Functions with Live Keys

- [ ] Verify `.env` has live `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- [ ] Firebase Secret Manager: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set to live keys
- [ ] Plaid credentials set to production
- [ ] `firebase deploy --only functions`
- [ ] Stripe Dashboard: production webhook endpoint configured

### Priority 2: E2E Test Demo Flow on Device

- [ ] Fresh sign-up → profile setup → Screen Time setup
- [ ] Deposit real money ($5) via Stripe
- [ ] Quick block: one-tap → blocking → custom shield → end
- [ ] Group session on 2 phones: create → invite → accept → start → complete → payouts
- [ ] Withdrawal: show UI, initiate if bank verified
- [ ] Fix all bugs found during testing

### Priority 3: Demo Prep

- [ ] Pre-load demo account with balance
- [ ] Have backup accounts ready
- [ ] Rehearse demo script 3x on actual device
- [ ] Prepare slides as crash backup

### DO NOT TOUCH

- No new features
- No UI changes
- No refactoring
- No plant/blob work

---

## PHASE 1: SOLO SESSIONS (April 16-18) — ~7.5 Hours

**Goal**: Any user can stake money on solo focus sessions. No friends needed.

**Key insight**: Backend 100% built. `sessionStore.ts` has complete `startSession`/`completeSession`/`surrenderSession`. Cloud Functions `handleSessionComplete`/`handleSessionForfeit` exist. **Zero backend changes.** Pure UI wiring.

### Steps

1. **Session tab entry point** (1h) — `app/(tabs)/session.tsx`: Add "Solo Focus" card
2. **Wire confirm screen** (1.5h) — `app/session/confirm.tsx`: Call `sessionStore.startSession()` for solo mode
3. **Wire active screen** (2h) — `app/session/active.tsx`: Add `solo_staked` mode, read from `sessionStore`
4. **Wire complete screen** (30min) — `app/session/complete.tsx`: Fallback to `sessionStore.sessionHistory`
5. **Wire surrender screen** (30min) — `app/session/surrender.tsx`: Solo surrender path
6. **Tab recovery** (30min) — Show active solo session on app restart
7. **Testing** (1.5h) — Full E2E: start → block → complete/surrender → payout/forfeit

### Files to Modify

- `app/(tabs)/session.tsx`
- `app/session/select.tsx` (pass `mode=solo` param)
- `app/session/confirm.tsx`
- `app/session/active.tsx`
- `app/session/complete.tsx`
- `app/session/surrender.tsx`

---

## PHASE 2: CAMPUS LAUNCH (April 19 - May 5)

**"Lock In For Finals"** — Posters, flyers, QR codes on campus.

**Hard blocker**: Apple extension entitlements (submitted April 10, pending).

### Marketing

- Posters: "Lock In For Finals" / "Compete with friends on screen time"
- QR code → TestFlight link
- Promo: "Complete 5 sessions with friends → earn $5 free" ($100 pool from 4 teammates)
- Short demo video for Instagram/TikTok

### Technical

- [ ] Firebase App Check implementation (safe to do post-demo with new build)
- [ ] TestFlight build + distribution
- [ ] Crash monitoring (Sentry or Expo crash reports)
- [ ] Onboarding copy: explain why blocking is unbypassable (FamilyControls)
- [ ] Analytics events: DAU, session starts/completions, deposits, withdrawals
- [ ] Promo bonus Cloud Function (~2h)

### Metrics to Collect

- Daily Active Users (DAU)
- Session completion rate (% complete vs surrender)
- Average stake amount
- Retention (Day 1, Day 7)
- Deposit → withdrawal conversion

---

## PHASE 3: POST-GRADUATION (May 8+)

1. Schedule-based blocking (DeviceActivitySchedule API)
2. DeviceActivityReport analytics screen
3. Custom in-app KYC (replace Stripe Express onboarding)
4. Plant social credit system
5. Interactive blob maker
6. Subscription tier ($3-5/mo for analytics + schedules)
7. Android investigation

---

## Completed (Previous Sprint)

| Item                                             | Status  |
| ------------------------------------------------ | ------- |
| Shield surrender desync bug fix                  | ✅ Done |
| Custom Niyah-branded shield                      | ✅ Done |
| ManagedSettingsStore.Name fix in extensions      | ✅ Done |
| linkBankAccount errors (Express accounts)        | ✅ Done |
| Withdraw screen rewrite + polish                 | ✅ Done |
| findContactsOnNiyah rate limit + caching         | ✅ Done |
| Dead UI removed (schedule/calendar/report links) | ✅ Done |
| Phone SMS OTP auth                               | ✅ Done |
| Screen Time onboarding flow                      | ✅ Done |
| Contact-based friend discovery (enhanced)        | ✅ Done |
| Group session Cloud Functions (7 functions)      | ✅ Done |
| FCM push notifications (9 types)                 | ✅ Done |
| Plaid bank linking + legal acceptance CFs        | ✅ Done |
| FamilyControls Distribution approved (main app)  | ✅ Done |
| Stripe live mode business account                | ✅ Done |
| Plaid production access                          | ✅ Done |
| Niyah, Inc. incorporated with EIN                | ✅ Done |
| Landing page at niyah.live                       | ✅ Done |
| App icon + splash screen updated                 | ✅ Done |
| Stripe Connect Express onboarding flow           | ✅ Done |

---

## Immersion Showcase (April 16)

### Poster (36 x 48 inches)

- Product-focused, not research-style
- Sections: Problem → Solution → Architecture → Screenshots → Competitive Position → Future
- QR code to niyah.live (promotion opportunity)
- Author Contribution Statement required

### Presentation Setup

- Phone mirrored to monitor/mini-TV via adapter
- Live demo at station (same script as April 15, adapted for walk-up audience)
- Slides as backup on laptop

---

## Verification Checklist

- [ ] Real Stripe deposit processes and credits balance
- [ ] Real Stripe withdrawal initiates (or UI shown with processing explanation)
- [ ] Quick block: start → shield appears → end
- [ ] Group session: create → invite → accept → start → complete → payouts
- [ ] Push notifications fire for group events
- [ ] No dead-end buttons in UI
- [ ] Demo account pre-loaded with balance
- [ ] Demo rehearsed 3x on actual device
