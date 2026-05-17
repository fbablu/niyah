import Foundation
import ActivityKit

/// `ActivityAttributes` mirror used by the widget extension. The main app
/// has its own copy at `modules/niyah-screentime/ios/NiyahActivityAttributes.swift`
/// so the pod compiles it into the `NiyahScreenTime` module. Both copies
/// MUST stay structurally identical or ActivityKit can't decode across
/// processes.
@available(iOS 16.1, *)
public struct NiyahActivityAttributes: ActivityAttributes {
  public let sessionId: String
  public let sessionType: String
  public let blobAssetName: String

  public init(sessionId: String, sessionType: String, blobAssetName: String) {
    self.sessionId = sessionId
    self.sessionType = sessionType
    self.blobAssetName = blobAssetName
  }

  public struct ContentState: Codable, Hashable {
    public let endsAt: Double
    public let leaderboard: [LeaderboardEntry]
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
    public let status: String
    public let violations: Int

    public init(name: String, status: String, violations: Int) {
      self.name = name
      self.status = status
      self.violations = violations
    }
  }
}
