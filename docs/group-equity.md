# Group Equity (Cap-Target Payout Model)

> Design doc for the post-demo group-fairness rework. Closes the "heavy vs light user mismatch is unfair" gap surfaced in TestFlight 1.0.0 (11).
> See also: [Payments](./payments.md) | [Features](./features.md) | [Native Modules](./native-modules.md) | [Post-Demo Roadmap](./post-demo-roadmap.md)

## Problem

Group sessions currently split the pool equally among completers (`src/utils/payoutAlgorithm.ts`). A teammate who averages 8h of TikTok per day and one who averages 30min play the "same" game even though abstaining costs them very different amounts of behavioral effort. Heavy users feel the friction; light users coast to the payout. Testers asked for a handicap-style model.

## Decision (user-confirmed)

**Total screen-time cap target per user**, set as a fraction of that user's measured baseline. Cap is verified at settlement time by the `NiyahDeviceActivityReport` extension (Lane B1 in [post-demo-roadmap.md](./post-demo-roadmap.md)). Strava-style — every participant runs against their own baseline.

## Cap definition

```
baseline_i = avg daily usage of monitored category for user i (DeviceActivityReport, trailing 7 days)
cap_i      = baseline_i × CAP_FACTOR   (CAP_FACTOR default = 0.5)
```

`CAP_FACTOR` is a per-session knob:

- Default `0.5` — "halve your usage during the session window".
- Proposer can override at session create (`0.25` ... `0.9`).
- Per-user overrides are not supported in v1 (collusion risk).

For session duration `T`, the effective cap is:

```
session_cap_i = cap_i × (T / 24h)
```

Baseline must have at least 24h of DeviceActivityReport history. Without baseline data the user is treated as "no cap" (completers pool, current behavior) — surfaced in UI so they know.

## Verification

DeviceActivityReport (`NiyahDeviceActivityReport` extension, iOS 16+) writes per-category usage to App Group `UserDefaults`. Bridge method `getScreenTimeBaseline()` on `NiyahScreenTimeModule.swift` returns the measured usage for the session window when the participant reports completion. Data is **trusted** — the extension runs in its own sandbox; the client cannot fake it without breaking the entitlement chain.

For users without a 24h baseline (new installs, just-onboarded), the proposer sees a "Some participants haven't built a baseline yet — cap target won't apply to them this session" banner.

## Payout impact

Each participant's payout factor `f_i` ∈ [0, 1]:

| Condition | `f_i` | Effect |
|---|---|---|
| Surrendered | `0` | No share |
| Completed, screen-time `s_i ≤ session_cap_i` | `1` | Full share |
| Completed, `s_i` between cap and 2× cap | linear: `f_i = (2·cap - s_i) / cap` | Scaled share |
| Completed, `s_i > 2× session_cap_i` | `0` | Treated as surrender for payout (still no forfeit; stake refunded) |

The pool is then split proportionally to `f_i`:

```
pool        = sum(stake_i) for all i
share_i     = pool × f_i / sum(f_j over j)
```

If everyone is at full cap, the model degrades to today's even-split behavior. If everyone overshoots, the pool stays with Niyah (treated as Niyah revenue).

## Edge cases

- **Single participant**: cap-target model does not apply — solo sessions stay on the multiplier path (`SOLO_COMPLETION_MULTIPLIER`).
- **Cap = 0 (baseline ≈ 0)**: lift to a floor of 10 minutes/day so a near-zero baseline doesn't trap users.
- **Mid-session re-categorization**: cap is locked at session start (snapshot of baseline at that moment); later DeviceActivityReport updates don't retroactively change the cap.
- **Time-zone drift**: cap and usage windows are both computed in the proposer's local timezone, frozen at session create.

## Anti-cheat considerations

- Baseline is **trustworthy** — DeviceActivityReport extension is sandboxed by iOS; a tampered client cannot inject arbitrary minutes.
- Baseline is **server-confirmed** — the extension writes via App Group, the JS bridge reads, and the value is sent to `distributeGroupPayouts` as a signed payload. Server stores the baseline used at settle time so audits can replay.
- **Selection gaming** (user picks only categories they barely use to inflate their cap): mitigated at onboarding by the redesigned app-selection screen (Lane B3) — top usage apps are shown with daily averages, hiding them is visible to other participants.
- **New-account farming**: gated by withdrawal eligibility (5 completed sessions + 2 distinct friends, already enforced in `assertWithdrawalEligibility`).

## Open questions

1. **Default `CAP_FACTOR`**: 50% is the user-chosen default. Need finals-cohort data before defaulting differently (Lane E1 / [roadmap.md](./roadmap.md) Phase 4 metrics).
2. **Off-platform usage**: cap target only measures phone usage on the configured categories. A user could "complete" by switching to a laptop. Acceptable for v1; revisit if it becomes a common evasion.
3. **Display in UI**: live screen-time vs cap on the in-session leaderboard? Sensitive personal data — opt-in only. Default: show your own cap progress; show others' cap pass/fail only at completion.

## Implementation pointers

| Concern | Where |
|---|---|
| Cap calculation | `src/utils/payoutAlgorithm.ts` (extend `calculatePayouts`, add `calculateCapTargetPayouts`) |
| Baseline read | `src/config/screentime.ts` → `getScreenTimeBaseline()` (Lane B2) |
| Session schema | `GroupSessionDoc.participants[uid]` adds `baselineMs`, `capFactor`, `usedMs` |
| Settlement | `distributeGroupPayouts` in `functions/src/index.ts` consumes `usedMs` from extension snapshot, applies `f_i` |
| Audit | `groupSessions/{id}.payoutAudit` records `baselineMs`, `cap`, `used`, `factor` for each participant |
