# Niyah — Post-Demo Stabilization & Premium UX Plan

> Living tracker for the post-demo (May 2026+) work. Closes the 11 gaps surfaced in TestFlight 1.0.0 (11) testing on May 5, 2026.
> See also: [Roadmap](./roadmap.md) · [Features](./features.md) · [Payments](./payments.md) · [Native Modules](./native-modules.md)

## Context

Today is **2026-05-05**, three weeks after the April 15 demo and at the tail of the Vanderbilt "Lock In For Finals" campus launch. The roadmap (`docs/roadmap.md`) was last updated 2026-04-12 and Sprint April 15 (`docs/sprint-april15.md`) is now historical. Live Stripe + Plaid keys are deployed, FamilyControls Distribution is approved, and the app is shipping real money — but TestFlight build 1.0.0 (11) surfaced a long list of UX, reliability, and feature gaps that need to be closed before the next public push (post-grad fundraising, May 8+).

This plan covers all 11 user-reported issues from the May 5 testing session, splits work into **4 parallel swimlanes** (plus an independent docs lane) so the solo-dev workload can be paged in/out without blocking, and produces refreshed docs (`docs/roadmap.md`, refreshed `docs/payments.md`, `docs/features.md`, new `docs/group-equity.md`).

### User-confirmed design decisions

| Decision | Choice |
|---|---|
| Group fairness model | **Total screen-time cap target** per user (handicap-style, Strava-like). Requires DeviceActivityReport extension. |
| Solo timer pause behavior | **Pause = early surrender confirm** (no real pause; pressing play opens forfeit sheet). |
| Multi-provider sign-in | **Auto-link if phone OR email matches** an existing user via `linkWithCredential`. |
| Live Activities scope | **Full** lock screen + Dynamic Island + leaderboard. |

## Gap Matrix — docs vs code vs reality

| Area | Docs say | Code does | User reports |
|---|---|---|---|
| Phone OTP | "Done" | 60s resend cooldown only; `auth/too-many-requests` shown but no global throttle | 15-min Firebase quota lockouts during dev testing |
| App Check | Soft-fail (rollout) | Soft-fail still in `src/config/appCheck.ts:47` | Likely contributing to abusive-traffic flags on phone OTP |
| Account linking | Not mentioned | No `linkWithCredential` calls anywhere | Same person → multiple uids when switching providers; profile feels desynced |
| Keyboard avoidance | Not specified | Only `app/session/surrender.tsx:375` and `verify-identity.tsx:260` use `KeyboardAvoidingView` | Most input screens hide behind keyboard |
| Group session modals | Not specified | `Alert.alert` in invites/waiting-room/active/confirm | Stacked modals during group flow feel buggy |
| Screen Time selection | "Apple default UI picker" | `presentAppPicker()` only — no usage data, no top-N suggestions | UX feels primitive vs Opal/BePresent |
| Group equity | "Pool splits among completers equally" | Yes (`src/utils/payoutAlgorithm.ts`) — no baseline weighting | Heavy + light user mismatch is unfair |
| Active timer UI | "Circle timer" | `src/components/Timer.tsx` SVG ring only | Wants YouTube-style scrubber + pause/play |
| Shield UX | Generic shield branding done | Static cycling quotes via session context UserDefaults | Wants per-app shield variants + real-time tease pushes to other members |
| Shield surrender | Deep link `niyah://surrender` directly forfeits | `ShieldActionExtension.swift:88` | Wants two-step: shield tap → push → tap push → confirm in app |
| Push notifications | "9 FCM types" | Foreground = `Alert.alert`, background = system tray | Foreground notifications invisible; not enough types |
| Live Activities | Not in scope | None — zero ActivityKit code | Wants Dynamic Island-style ongoing notification |
| Plaid bank change | Not specified | "Connect Different Bank" relink button only; no unlink CF | Old bank stuck after relink |
| Withdrawals of earned funds | "Single balance field, idempotent" | One `wallets/{uid}.balance` (cents); should support earned funds | "Sometimes works, sometimes doesn't" — needs reliability audit |
| Roadmap | Pre-Phase-3 | Phase 3 active, Phase 4 unscoped | Stale; needs refresh for post-grad |

## Architecture decisions

**A. New iOS extension target: `NiyahDeviceActivityReport`**
DeviceActivityReport API (iOS 16+) is the only sanctioned way to read per-app usage data. We need a new app extension target that surfaces aggregated daily-average usage for the user's selected categories. Bridge to JS via `modules/niyah-screentime/ios/NiyahScreenTimeModule.swift` adding `getScreenTimeBaseline()`. Unlocks both the redesigned app-selection flow (Cluster D) and group equity (Cluster E).

**B. New iOS Live Activity widget target: `NiyahLiveActivity`**
ActivityKit target with `ActivityAttributes` for sessionId, blob asset, leaderboard. Bridge: extend Screen Time module (or new `NiyahLiveActivityModule`) with `start/update/end` methods, called from `src/store/sessionStore.ts` and `src/store/groupSessionStore.ts`.

**C. Account-linking flow at auth-store level**
Before creating a new Firebase user on second-provider sign-in, query Firestore for users matching the verified `email` or `phoneNumber`. If found and provider not yet linked, call `linkWithCredential` on the existing user instead of creating a new one. Migration script for already-duplicated users to merge wallets.

**D. Replace `Alert.alert` with in-screen banners**
Adopt one consistent in-screen banner component (`src/components/StatusBanner.tsx`, new) for transient state changes (invite accepted, member joined, member surrendered, session cancelled, etc.). Reserve native `Alert.alert` for destructive confirmations only.

**E. Foreground push via `@notifee/react-native`**
The current `setupForegroundHandler` (`src/config/notifications.ts:191`) shows an Alert which the user finds invisible. Notifee renders proper banner notifications even with the app in foreground, sound + tap-to-deep-link.

## Parallel Work Swimlanes

Four swimlanes designed to be worked on in parallel by separate sessions/agents. Within each lane tasks are sequential. No two lanes touch the same file (with one exception flagged in Lane C/D coordination). Each task has explicit acceptance criteria.

Tasks marked **[no-build]** can be implemented and tested without running the iOS build or dev server (pure code edits + unit tests + typecheck). Tasks marked **[needs-build]** require a native rebuild or device run before they're verifiable.

---

### Lane A — Auth, Identity, Profile, Keyboard (~3 days)

Scope: everything in `app/(auth)/`, `src/store/authStore.ts`, `src/config/firebase.ts`, `src/config/appCheck.ts`, plus a global keyboard fix.

**A1. Phone OTP global throttle [no-build]**
- Add `phoneOtpRateLimiter` in `src/store/authStore.ts`: persist `{ lastSentAt, sendCount, windowStart }` in AsyncStorage.
- Rule: max 5 OTP sends per phone per 60min, exponential backoff after 3 (30s, 2m, 5m).
- Surface remaining cooldown in `app/(auth)/phone-entry.tsx` UI before hitting Firebase.
- Catch `auth/too-many-requests` → display friendly message + persist long cooldown to prevent retry loop.

**A2. App Check hard enforcement on auth-related Cloud Functions [no-build]**
- Flip soft-fail flag in `src/config/appCheck.ts` to enforce mode.
- Update `functions/src/index.ts` to require valid App Check token on `createPlaidLinkToken`, `linkBankAccount`, `requestWithdrawal`, `createGroupSession`. (Reduces Firebase abusive-traffic detection that triggers OTP rate limits.)
- Document expected Sentry error rate during rollout.

**A3. Multi-provider account linking [no-build]**
- New util `src/utils/accountLinking.ts`:
  - `findExistingUserByPhoneOrEmail(phone, email)` — Firestore query on `users` collection.
  - `linkProviderToExistingUser(credential, existingUid)` — uses `linkWithCredential`.
- Hook into `authStore.signInWithGoogle()`, `signInWithApple()`, `verifyPhoneCode()` after Firebase Auth success but before profile creation.
- If linking succeeds, replace local auth state with linked user; merge any newly-created stub user doc into existing one.

**A4. Migration for existing duplicates [no-build]**
- New Cloud Function `mergeDuplicateUsers` (admin-triggered, not automatic): find users with same verified phone/email but different uid, merge wallets via transaction, log to `migrations/{date}` audit collection.
- Run once against prod. Document in `docs/payments.md`.

**A5. Profile sync source-of-truth fix [no-build]**
- `src/config/firebase.ts:saveUserProfile()` — pull `displayName`, `email`, `phoneNumber` directly from `firebase.auth().currentUser` on every profile save, not from local form state.
- Remove duplicate phone field; keep `auth.phoneNumber` only.
- Update `buildUser()` (`authStore.ts:174`) to dedupe.

**A6. Global keyboard avoidance [needs-build for verification]**
- Install `react-native-keyboard-controller` (best-in-class for "scroll-to-focused-input"; pure native).
- Mount `<KeyboardProvider>` at `app/_layout.tsx` root.
- Replace ad-hoc `KeyboardAvoidingView` in `surrender.tsx` and `verify-identity.tsx` with `<KeyboardAwareScrollView>` from the new lib.
- Add `<KeyboardAwareScrollView>` to: `app/(auth)/phone-entry.tsx`, `verify-phone.tsx`, `profile-setup.tsx`, `app/session/propose.tsx`, `app/session/deposit.tsx`, `app/(tabs)/friends.tsx`.
- Acceptance: typing OTP, custom amount, friend search, QUIT confirm — all keep input visible above keyboard with auto-scroll.

**Lane A files:** `app/(auth)/*.tsx` (4 files), `app/_layout.tsx`, `app/session/propose.tsx`, `app/session/deposit.tsx`, `app/(tabs)/friends.tsx`, `src/store/authStore.ts`, `src/config/firebase.ts`, `src/config/appCheck.ts`, `src/utils/accountLinking.ts` (new), `functions/src/index.ts` (mergeDuplicateUsers), `package.json` (+react-native-keyboard-controller).

---

### Lane B — Native iOS: DeviceActivityReport + Live Activities + Shield UX (~5 days)

Scope: new iOS extension targets, Swift module additions, plugin updates. Heaviest native lift but cleanly isolated from JS-layer work. **All Lane B tasks are [needs-build].**

**B1. New extension target `NiyahDeviceActivityReport`**
- Add `ios/NiyahDeviceActivityReport/` with `DeviceActivityReport.swift` extension and SwiftUI scenes for daily/weekly app usage.
- Update `plugins/withScreenTimeExtensions.ts` to register the new target and entitlement.
- Update `app.config.ts` extras with new bundle id.
- Acceptance: extension builds, FamilyControls Distribution entitlement attached, scene visible in development overlay.

**B2. Bridge `getScreenTimeBaseline()` in `NiyahScreenTimeModule.swift`**
- New method returning `[(appToken, dailyAverageMinutes, weeklyTotal, category)]`.
- Reads from DeviceActivityReport via app-group UserDefaults (extension writes, module reads).
- Add to `src/config/screentime.ts` JS wrapper.
- Acceptance: JS call returns sorted array of user's top apps with usage; works when extension has had ≥24h of data.

**B3. Redesigned app-selection onboarding**
- New screen `app/(auth)/screentime-baseline.tsx`: prompts "Select all apps to monitor" with Apple's category-level FamilyActivityPicker; calls `presentAppPicker()` with broader selection.
- After 24h baseline collected, new screen `app/screentime-priorities.tsx`: shows ranked app list with daily averages, lets user mark "block hard / block sometimes / track only" per app. Persist as `users/{uid}.screenTimeProfile`.
- Update onboarding router: phone-entry → verify-phone → profile-setup → screentime-baseline → quick-block intro.
- Acceptance: a user with 8h daily TikTok usage sees TikTok at top of priorities list with "8h avg" badge.

**B4. Per-app shield variants**
- `ios/NiyahShieldConfiguration/ShieldConfigurationExtension.swift`: branch on `application.token` and `category.token` in `makeConfiguration()`.
- Add 5 visual variants (social, video, gaming, news, default) — different background gradients + matching pep-talk copy.
- Add 20+ new rotating quotes per category, varied by `Calendar.minute` modulus.
- Acceptance: blocking Instagram shows social-themed shield; blocking YouTube shows video-themed shield.

**B5. Two-step shield surrender via push**
- `ios/NiyahShieldAction/ShieldActionExtension.swift`: change secondary action handler:
  - Write `niyah_surrender_pending` flag to App Group UserDefaults (instead of `niyah_surrender_requested`).
  - Schedule local `UNUserNotification` titled "Tap to confirm surrender" with category `SURRENDER_CONFIRM` and action button "Confirm forfeit ($X)".
  - Do NOT auto-deep-link to app.
- New JS handler in `src/config/notifications.ts`: when notification with category `SURRENDER_CONFIRM` is tapped, deep-link to `/session/active?confirmSurrender=true`.
- `app/session/active.tsx`: when `confirmSurrender=true`, present prominent confirm sheet with HoldToConfirmModal.
- Remove `onSurrenderRequested` immediate-fire path (or keep as fallback-only).
- Acceptance: tapping shield "Unlock & forfeit" shows push, tapping push opens leaderboard with confirm sheet, confirm completes surrender.

**B6. Live Activity target `NiyahLiveActivity`**
- New `ios/NiyahLiveActivity/` widget extension (ActivityKit + WidgetKit).
- `ActivityAttributes`: sessionId, sessionType (solo/group), endsAt, blobAssetName, leaderboard (top-3 entries with name + status + violations).
- 4 layouts: lock-screen, Dynamic Island compact (timer + blob), expanded (timer + leaderboard), minimal (just timer).
- Update on every Firestore session-doc change.

**B7. Bridge Live Activity start/update/end**
- New module method on `NiyahScreenTimeModule.swift` (or new `NiyahLiveActivityModule`): `startLiveActivity(attrs)`, `updateLiveActivity(state)`, `endLiveActivity()`.
- Hook from `src/store/sessionStore.ts` (solo) and `groupSessionStore.ts` (group):
  - On session start → `startLiveActivity`.
  - On session-doc Firestore subscription tick → `updateLiveActivity`.
  - On complete/surrender → `endLiveActivity`.
- Acceptance: session start → Dynamic Island shows timer + blob; tapping screen on lock shows full leaderboard.

**Lane B files (no overlap with Lane A or C):** `ios/NiyahDeviceActivityReport/` (new), `ios/NiyahLiveActivity/` (new), `ios/NiyahShieldConfiguration/ShieldConfigurationExtension.swift`, `ios/NiyahShieldAction/ShieldActionExtension.swift`, `modules/niyah-screentime/ios/NiyahScreenTimeModule.swift`, `modules/niyah-screentime/expo-module.config.json`, `plugins/withScreenTimeExtensions.ts`, `app.config.ts`, `src/config/screentime.ts`, `app/(auth)/screentime-baseline.tsx` (new), `app/screentime-priorities.tsx` (new).

---

### Lane C — Group Session UX, Inline State, Push Visibility, Active Timer (~3 days)

Scope: replace modals with inline state, redesign solo timer, richer push notifications. Sits at JS layer; coordinates with Lane B for shield-surrender deep link (B5) and Live Activity bridge (B7).

**C1. New `<StatusBanner>` component [no-build]**
- `src/components/StatusBanner.tsx`: animated top-of-screen banner with severity (info/success/warn/error) + auto-dismiss + queue.
- Mounted in `app/_layout.tsx` so any screen can call `useStatusBanner().show({ message, severity })`.

**C2. Replace Alert.alert across group flow [no-build]**
- `app/session/invites.tsx:73,90` — accept/decline errors → StatusBanner.
- `app/session/waiting-room.tsx:332,378,387,399` — cancellations, start errors, cancel-confirm → inline status pill at top of screen + bottom-sheet for cancel-confirm.
- `app/session/confirm.tsx:272` — cannot start → StatusBanner.
- `app/session/active.tsx:572` — violations → StatusBanner (transient).
- Keep `HoldToConfirmModal` (it's intentional, high-risk).

**C3. Live group leaderboard improvements [no-build]**
- `app/session/active.tsx:297-333` — already exists. Augment with:
  - Real-time payout-share preview that shifts as members surrender (already settled by Cloud Function on completion; here just compute optimistic local share).
  - Per-app violation pill ("John opened YouTube 2× this hour").
  - Smooth row reorder animation (`react-native-reanimated` `Layout` API).

**C4. Solo timer redesign — YouTube-style scrubber + pause-as-surrender [no-build]**
- `src/components/Timer.tsx` — new variant `mode: 'scrubber'`:
  - Horizontal progress bar with scrubber thumb (decorative, non-interactive past current time).
  - Center play/pause button (shows pause during active session).
  - Tapping pause → opens `HoldToConfirmModal` "End early and forfeit $X?" (per user-confirmed pause = surrender confirm).
- Keep ring variant available for legacy use (group session can stay ring or also adopt scrubber).
- Acceptance: solo session shows scrubber + pause; tapping pause opens forfeit confirm.

**C5. Foreground push notifications via `notifee` [needs-build for verification]**
- Install `@notifee/react-native`.
- Replace `Alert.alert` in `src/config/notifications.ts:setupForegroundHandler` with `notifee.displayNotification` with sound + iOS critical alert level.
- Map FCM data payload → notifee channel + category (so taps deep-link the same way as background).

**C6. Richer in-session push types [no-build]**
- Add 4 new FCM message types in `functions/src/index.ts`:
  - `member_app_opened` — "John just opened YouTube — losing $X share" (≥30s cooldown per member).
  - `leaderboard_shift` — when payout share changes ≥10% (e.g., someone surrendered) — "Sarah just surrendered. Your share is now $X."
  - `session_progress_25/50/75` — progress milestones.
  - `surrender_confirm_pending` (Lane B5 dependency) — "Tap to confirm surrender of $X."
- Update `reportShieldViolation` (`functions/src/index.ts:3766`) to emit `member_app_opened` instead of generic shield_violation.

**C7. Real-time payout leaderboard during session [no-build]**
- Already present via `subscribeToSession` (`groupSessionStore.ts:220`).
- Add optimistic local payout calculation in `src/utils/payoutAlgorithm.ts` (new function `optimisticGroupPayouts(session)`) that recomputes whenever a participant transitions to surrendered.
- Wire into `app/session/active.tsx` leaderboard.

**Lane C files:** `src/components/StatusBanner.tsx` (new), `src/components/Timer.tsx`, `app/_layout.tsx`, `app/session/invites.tsx`, `app/session/waiting-room.tsx`, `app/session/confirm.tsx`, `app/session/active.tsx`, `src/config/notifications.ts`, `src/utils/payoutAlgorithm.ts`, `functions/src/index.ts` (push additions), `package.json` (+notifee).

---

### Lane D — Plaid Bank Management + Payout Reliability + Withdrawals (~2 days)

Scope: bank lifecycle, withdrawal of earned funds, reconciliation. Mostly Cloud Functions + a profile-screen tweak. Coordinates with Lane C only on `functions/src/index.ts` (different functions, low conflict). **All Lane D tasks are [no-build]** (Cloud Functions + JS edits).

**D1. Cloud Function `unlinkBankAccount`**
- New `functions/src/index.ts` function: detaches Stripe external account, clears `users/{uid}.linkedBank` and Plaid token reference.
- Idempotent — safe to call repeatedly.
- Sentry breadcrumb on each step.

**D2. Cloud Function `replaceBankAccount`**
- Combines unlink + new Plaid Link in single transaction. Old token revoked only after new one validated.
- Error path: if new link fails, old bank stays.

**D3. Profile UI — "Manage Bank"**
- `app/(tabs)/profile.tsx:115-127` — replace passive `linkedBank` display with:
  - Bank name + mask + "Manage" button.
  - Tap "Manage" → action sheet: "Replace bank" / "Remove bank".
- Remove → confirm → `unlinkBankAccount` CF.
- Replace → start Plaid Link flow → on success, `replaceBankAccount` CF.

**D4. Withdrawal availability indicator**
- `app/session/withdraw.tsx`: show "Available to withdraw: $X" derived from `wallets/{uid}.balance` directly.
- Add tooltip "Earned funds are immediately available." (No separate buckets needed; user-confirmed single balance is fine.)
- Min/max banner: $10 min, daily $25k cap.

**D5. Payout reliability — reconciliation Cloud Function**
- New scheduled function `reconcileWalletBalances` (nightly): for every wallet, sum `transactions` where `userId == uid`, compare to `wallets/{uid}.balance`. Log mismatches to `walletAudits` collection + Sentry alert.
- Add idempotency key to every `transfers.create` call (`functions/src/index.ts:2081`) using `${sessionId}_${userId}_${type}`.
- Verify all `FieldValue.increment` calls in payout settlement (`distributeGroupPayouts:2157`) are inside transactions and guarded by `payoutsSettledAt` timestamp (already are per audit; add comment + test).

**D6. Sentry instrumentation on payout path**
- Wrap `distributeGroupPayouts`, `requestWithdrawal`, `linkBankAccount` with breadcrumb context (sessionId, userId, amount, step name).
- Use existing logger (`src/utils/logger.ts` per recent commits).

**D7. Integration test for earned-funds withdrawal**
- New file `functions/test/withdraw-earned.test.ts`: Stripe test mode end-to-end:
  1. User A starts solo session ($20 stake), completes → wallet incremented to $40 (1x stickK or 2x — see open question in `docs/payments.md` line 61).
  2. User A withdraws $40 → Stripe transfer succeeds → wallet balance $0.
  3. Verify transaction log has `payout` then `withdrawal` entries with consistent timestamps.

**Lane D files:** `functions/src/index.ts` (new functions D1, D2, D5; instrumentation D6), `app/(tabs)/profile.tsx`, `app/session/withdraw.tsx`, `app/session/bank-setup.tsx` (replace flow), `functions/test/withdraw-earned.test.ts` (new).

---

## Lane Coordination

The only file touched by **two lanes** is `functions/src/index.ts` (Lanes A4, C6, D1/D2/D5). Coordinate:

- Lane A4 adds `mergeDuplicateUsers` (callable, admin-only)
- Lane C6 adds 4 new FCM message types in existing send-push helper
- Lane D adds `unlinkBankAccount`, `replaceBankAccount`, `reconcileWalletBalances` (scheduled)

These add isolated functions — no shared code paths. Suggest one lane (D) lands first since it's smallest, then A4 + C6 in parallel.

`app/session/active.tsx` is touched by Lane B5 (shield-surrender deep link confirm) and Lane C2/C3/C7 (banner replacements + leaderboard). Sequence Lane C2/C3 first; Lane B5 only adds a new query-param handler. Low conflict.

## Doc Refresh (Lane E — independent, anytime)

**E1. `docs/roadmap.md`** — refresh with current phase tracking:
- Mark "Demo Day Apr 15" ✅ executed.
- Mark "Solo Sessions UI wiring" as either ✅ done or fold into post-demo lanes if still incomplete.
- Update Phase 3 (Campus Launch Apr 19 – May 5) with actual outcomes (need user input).
- Add new Phase 4: "Premium UX Push" referencing this plan.

**E2. New `docs/post-demo-roadmap.md`** — this file. Living tracker.

**E3. `docs/payments.md`** refresh:
- Section "Solo Multiplier Reconciliation" — pick 1x or 2x and remove "deferred" language.
- New section "Bank Management" — covers replace/unlink flow.
- New section "Wallet Reconciliation" — describes nightly reconcile job.

**E4. `docs/features.md`** — add:
- Account linking (multi-provider).
- Screen Time Baseline + Priorities (DeviceActivityReport-driven).
- Live Activities + Dynamic Island.
- Per-app shield variants.
- Group equity model (cap-target).

**E5. `docs/native-modules.md`** — add `NiyahDeviceActivityReport` and `NiyahLiveActivity` extensions.

**E6. New `docs/group-equity.md`** — design doc for cap-target model:
- How cap is set (default = baseline × 0.5, user can override).
- Verification mechanism (DeviceActivityReport reads).
- Payout impact (under-cap = full share; over-cap = scaled down or zero).
- Anti-cheat considerations (extension data is trustworthy; client cannot fake).

**E7. Mark `docs/sprint-april15.md` historical** — add header "✅ COMPLETE — see `post-demo-roadmap.md` for next phase."

## Verification

End-to-end test scripts to run after each lane (or after full merge):

**Lane A:**
- Phone OTP: send 6 codes within 1h → 6th blocked client-side with cooldown timer (Firebase quota never hit).
- Sign in with phone using number 555-1234 → enter name → sign out → sign in with Google using account whose verified email matches that user → expect single uid, single balance, name preserved.
- Type in OTP code field, custom amount, friend search, QUIT confirm — keyboard never hides the input.

**Lane B:**
- Onboarding: pick all categories → wait 24h → priorities screen shows top apps with daily averages.
- Block Instagram → see social-themed shield. Block YouTube → see video-themed shield.
- Tap shield "forfeit" → push appears → tap push → app opens leaderboard with confirm sheet → confirm → session forfeits.
- Start session → lock phone → see Live Activity on lock screen with timer + blob. Long-press Dynamic Island → expanded leaderboard.

**Lane C:**
- Group invite flow: every state transition (invite, accept, decline, ready, start, surrender, complete) shows banner not modal.
- Solo session: timer is scrubber; tap pause → forfeit confirm sheet appears.
- Foreground push: app open + group invite arrives → notifee banner appears (not Alert).

**Lane D:**
- Profile → Manage Bank → Replace → Plaid Link → new bank shown, old removed.
- Stripe test mode: complete solo session, withdraw earned funds, verify Stripe transfer + wallet=0.
- Run reconcile job manually → no mismatches in test data.

**Lane E:** docs render in GitHub markdown, links resolve.

## Critical files summary

```
Lane A — Auth + Keyboard
  app/(auth)/{phone-entry,verify-phone,profile-setup}.tsx
  app/_layout.tsx
  app/session/{propose,deposit}.tsx
  app/(tabs)/friends.tsx
  src/store/authStore.ts
  src/config/{firebase,appCheck}.ts
  src/utils/accountLinking.ts (new)
  functions/src/index.ts (mergeDuplicateUsers)

Lane B — Native iOS
  ios/NiyahDeviceActivityReport/ (new target)
  ios/NiyahLiveActivity/ (new target)
  ios/NiyahShieldConfiguration/ShieldConfigurationExtension.swift
  ios/NiyahShieldAction/ShieldActionExtension.swift
  modules/niyah-screentime/ios/NiyahScreenTimeModule.swift
  plugins/withScreenTimeExtensions.ts
  app.config.ts
  src/config/screentime.ts
  app/(auth)/screentime-baseline.tsx (new)
  app/screentime-priorities.tsx (new)

Lane C — Inline UX + Push + Timer
  src/components/{StatusBanner,Timer}.tsx
  app/_layout.tsx (banner mount)
  app/session/{invites,waiting-room,confirm,active}.tsx
  src/config/notifications.ts
  src/utils/payoutAlgorithm.ts
  functions/src/index.ts (4 new push types)

Lane D — Bank + Payout Reliability
  functions/src/index.ts (unlinkBankAccount, replaceBankAccount, reconcileWalletBalances)
  app/(tabs)/profile.tsx
  app/session/{withdraw,bank-setup}.tsx
  functions/test/withdraw-earned.test.ts (new)

Lane E — Docs
  docs/roadmap.md
  docs/post-demo-roadmap.md (this file)
  docs/payments.md
  docs/features.md
  docs/native-modules.md
  docs/group-equity.md (new)
  docs/sprint-april15.md
```

## Reused existing patterns / utilities

- `HoldToConfirmModal` (`src/components/HoldToConfirmModal.tsx`) — reuse for solo pause-as-surrender (Lane C4) and shield-surrender confirm sheet (Lane B5).
- `useCountdown` hook — keep for both ring + scrubber timer variants (Lane C4).
- Firestore subscription pattern in `groupSessionStore.ts:subscribeToSession` — reuse for Live Activity update wiring (Lane B7).
- App-group UserDefaults bridge already used by shield + DeviceActivityMonitor — extend same pattern for DeviceActivityReport baseline data (Lane B2) and Live Activity state (Lane B7).
- Existing FCM `sendPushToUser` helper in `functions/src/index.ts` — reuse for new push types in Lane C6.
- `FieldValue.increment` + `payoutsSettledAt` idempotency pattern — reuse for any new wallet writes.

## Estimated total: ~13 dev days

Lane A: 3d · Lane B: 5d · Lane C: 3d · Lane D: 2d · Lane E: 0.5d (parallel).
With 2 lanes in flight at a time (max): ~7 calendar days. With 4 lanes maximally parallel: ~5 calendar days.

## No-build subset (safe to do from phone session)

For sessions where the dev server / iOS build is not available, work this list in any order:

- A1, A2, A3, A4, A5 (all Lane A except keyboard library install/wiring)
- C1, C2, C3, C4, C6, C7 (all Lane C except notifee install/wiring which is C5)
- D1, D2, D3, D4, D5, D6, D7 (entire Lane D)
- E1–E7 (all docs)

Total no-build coverage: ~70% of the plan. Lane B (entire), A6, and C5 are deferred to a build-capable session.

## Open items needing user input post-approval

1. **Solo payout multiplier**: confirm 1x (stickK) or 2x — currently `payoutAlgorithm.ts` says 2x but `sessionStore.ts` uses 1x. Lane E3 fixes the doc but the actual decision is yours.
2. **Default screen-time cap** for new group sessions: 50% of baseline? 80%? User-set per session? Lane B2 + Lane E6 design doc need this.
3. **Push notification frequency limit** for `member_app_opened`: 30s cooldown sufficient or higher? Tease pushes risk spam.
4. **Phase 3 outcomes** for `docs/roadmap.md` E1 update: how did campus launch land? Numbers / learnings to record.
