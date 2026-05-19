# May 16, 2026 — progress + tomorrow's punch list

Big day. Lane B (the Live Activity + advanced shield work that's been blocking the demo experience) is now functional end-to-end. T-10 days to App Store live (May 26).

## Shipped today

### Architecture
- ✅ **Migrated all 5 iOS extensions to `@bacons/apple-targets`** (replaces 5 brittle custom plugins). See `docs/lane-b-apple-targets-migration.md`.
- ✅ **All 5 extensions compile clean** end-to-end (verified with `xcodebuild` against device-targeted scheme).
- ✅ **815/815 Jest tests passing** (3 test mocks updated to include Live Activity exports).

### Bug fixes
- ✅ **#1 Surrender 400 race** — `sessionStore.surrenderSession` no longer writes status=surrendered to Firestore client-side in non-DEMO mode; Cloud Function owns the status update via its transaction.
- ✅ **#2 Shield button kicks user out** — shield action now `completionHandler(.defer)` + `openMainApp("niyah://blocked")`. User lands inside Niyah, not at home screen.
- ✅ **#3 Session timer end** — `scheduleSessionEndNotification` via notifee TimestampTrigger; cancelled on early end. Wired into both `sessionStore.startSession` AND `groupSessionStore.startGroupSession` (the quick-block path). `recoverActiveSession` now also calls `stopBlocking()` to clear sticky shields when user reopens app after expiry.
- ✅ **#4 Custom shield UI** — full-screen branded `app/blocked.tsx` with pulsing animated blob avatar, kicker copy ("YOU BROKE FOCUS"), variant-aware quote, stake amount, group context, primary "Back to focus" / secondary "Forfeit stake & quit". Shield secondary button now reads "Open Niyah →".
- ✅ **#5 Live Activity wiring** — confirmed working on iPhone 14 lock screen for staked sessions. Same fix applied to non-staked quick-block path (`startGroupSession` legacy now fires `startLiveActivity`).

### Infra
- ✅ FamilyControls Distribution approved for all 5 extension bundle IDs.
- ✅ Stale `com.niyah.app.NiyahDeviceActivityReport` CamelCase App ID identified for deletion (replaced by hyphenated `com.niyah.app.device-activity-report`).

## Known issues — tomorrow's punch list

### Live Activity polish
- ⏳ **Blob avatar not visible on lock screen banner.** Widget extension uses `Image(assetName)` but the blob PNG assets aren't shipped to the widget bundle. Need to either:
  - Add `assets/blobs/*.png` and copy into `targets/widget/Assets.xcassets/`
  - Or render a programmatic SwiftUI shape instead of bitmap
- ⏳ **Live Activity is notification-sized, not card-sized.** Apple's `ActivityConfiguration` lock-screen layout has fixed max height. To look "bigger" we need to actually fill the available space with denser content (timer + leaderboard + payout meter), not bigger fonts. Iterate on `targets/widget/NiyahLiveActivityWidget.swift` `LockScreenLiveActivityView`.
- ⏳ **Verify Live Activity fires for non-staked quick-block** — fix is in code but Metro needs a reload to pick it up. Manual test tomorrow.

### Bug #3 oddity (not a real bug)
- ℹ️ **iCloud notification mirroring routes alerts to Mac** when the Mac is "active" — phone suppresses local alert. iOS feature, not a code bug. Phone WILL alert when Mac isn't paired/awake. Optionally disable on Mac: System Settings → Notifications → "Allow notifications from iPhone" OFF.

### Critical path to May 26 ship

In rough priority order:

1. **Live Stripe + Plaid key switch** + deploy Cloud Functions to production
2. **E2E with real money**: deposit → solo session → complete → payout (one $1 stake)
3. **App Store metadata**: screenshots (5+ per device size), description, privacy nutrition label, support URL, keywords, category
4. **Submit App Store build by May 21–22** EOD for 2–3 day review buffer
5. Live Activity polish (above)
6. Quality testing — solo + group flows, edge cases (no wifi, app killed mid-session, etc.)
7. Pre-trip logistics (Cambridge Airbnb May 25-29, Quincy hotel May 30, business cards, LinkedIn post)

## Files touched today

```
M  app.config.js
M  src/store/sessionStore.ts           (surrender race + scheduleSessionEndNotification + shield-clear in recovery)
M  src/store/groupSessionStore.ts      (scheduleSessionEndNotification + stopBlocking + startLiveActivity in legacy startGroupSession)
M  src/config/notifications.ts         (new scheduleSessionEndNotification + cancelSessionEndNotification helpers)
M  targets/shieldaction/ShieldActionExtension.swift   (.defer → direct-open Niyah)
M  targets/shieldconfig/ShieldConfigurationExtension.swift  (button label "Open Niyah →")
M  src/constants/config.ts             (LANE_B_ENABLED comment refresh)
A  app/blocked.tsx                     (full-screen custom surrender entry)
A  docs/may-16-progress.md             (this file)
M  src/__tests__/unit/store/sessionStore.fireAndForget.test.ts   (Live Activity mocks)
M  src/__tests__/unit/store/sessionStore.forgiveness.test.ts     (Live Activity mocks)
M  src/__tests__/unit/store/sessionStore.stakeCap.test.ts        (Live Activity mocks)
```

## To resume tomorrow

```bash
# 1. Pull / verify clean state
git status

# 2. Reload Metro (don't need full rebuild — JS-only changes)
pnpm start
# press 'r' once running

# 3. First test: quick-block non-staked → check lock screen for Live Activity
#    Should now appear (was missing before today's fix)

# 4. Pick from tomorrow's punch list above
```

## When the conversation context resets

You can come back tomorrow and pick up cold by:
1. Read `docs/may-16-progress.md` (this file)
2. Read `docs/sprint-april15.md` for broader plan (May 26 deadline)
3. `git log --oneline -20` to see today's commits
4. Start with the punch list at the top

The memory at `/Users/fardeenb/.claude/projects/-Users-fardeenb-Documents-Projects-niyah/memory/` carries over.
