import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// `ActivityAttributes` for Niyah Live Activities.
///
/// Shared between the main app (which starts/updates/ends the activity)
/// and the `NiyahLiveActivity` widget extension (which renders the UI).
/// Defined at the top of `modules/niyah-screentime/ios/` so the podspec
/// (`source_files = 'ios/*.swift'`) picks it up automatically for the
/// main app target; the `withLiveActivity` plugin also copies this file
/// into the widget extension's source dir so the widget can decode it.
///
/// ActivityKit requires iOS 16.1+; gated with `@available(iOS 16.1, *)`.
#if canImport(ActivityKit)
@available(iOS 16.1, *)
public struct NiyahActivityAttributes: ActivityAttributes {

  // ── Static (set once at start, never changes for this activity) ─────────
  public let sessionId: String
  /// "solo" | "group"
  public let sessionType: String
  /// Asset name for the user's blob avatar (e.g. "blob_basil").
  /// Widget extension looks this up from its own bundle.
  public let blobAssetName: String

  public init(sessionId: String, sessionType: String, blobAssetName: String) {
    self.sessionId = sessionId
    self.sessionType = sessionType
    self.blobAssetName = blobAssetName
  }

  // ── Dynamic state (updated as session progresses) ───────────────────────
  public struct ContentState: Codable, Hashable {
    /// Absolute end timestamp (seconds since epoch). Widget computes
    /// remaining live via `Date.now()` so we don't have to push every tick.
    public let endsAt: Double
    /// Top-3 participant snapshot for the leaderboard row.
    /// Empty for solo sessions (widget hides leaderboard).
    public let leaderboard: [LeaderboardEntry]
    /// Current optimistic payout share in cents for the local user.
    public let userPayoutCents: Int

    public init(
      endsAt: Double,
      leaderboard: [LeaderboardEntry],
      userPayoutCents: Int
    ) {
      self.endsAt = endsAt
      self.leaderboard = leaderboard
      self.userPayoutCents = userPayoutCents
    }
  }

  public struct LeaderboardEntry: Codable, Hashable {
    public let name: String
    /// "active" | "surrendered" | "completed"
    public let status: String
    public let violations: Int

    public init(name: String, status: String, violations: Int) {
      self.name = name
      self.status = status
      self.violations = violations
    }
  }
}
#endif
