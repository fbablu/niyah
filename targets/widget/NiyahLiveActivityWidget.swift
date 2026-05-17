import ActivityKit
import WidgetKit
import SwiftUI

/// Live Activity widget for Niyah focus sessions. See main app's
/// NiyahScreenTimeModule.swift for the bridge that starts/updates/ends.
@available(iOS 16.1, *)
struct NiyahLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: NiyahActivityAttributes.self) { context in
      LockScreenLiveActivityView(context: context)
        .padding(16)
        .activityBackgroundTint(Color.black.opacity(0.85))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          BlobBadge(assetName: context.attributes.blobAssetName, size: 36)
        }
        DynamicIslandExpandedRegion(.trailing) {
          TimerLabel(endsAt: context.state.endsAt, size: 18, weight: .semibold)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.attributes.sessionType == "group" ? "Group session" : "Focus session")
            .font(.footnote)
            .foregroundColor(.secondary)
        }
        DynamicIslandExpandedRegion(.bottom) {
          if !context.state.leaderboard.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
              ForEach(context.state.leaderboard.prefix(3), id: \.name) { entry in
                LeaderboardRow(entry: entry)
              }
            }
          } else {
            Text("Staying focused")
              .font(.caption)
              .foregroundColor(.secondary)
          }
        }
      } compactLeading: {
        BlobBadge(assetName: context.attributes.blobAssetName, size: 20)
      } compactTrailing: {
        TimerLabel(endsAt: context.state.endsAt, size: 14, weight: .medium)
      } minimal: {
        TimerLabel(endsAt: context.state.endsAt, size: 12, weight: .medium)
      }
      .keylineTint(Color.green)
    }
  }
}

@available(iOS 16.1, *)
struct LockScreenLiveActivityView: View {
  let context: ActivityViewContext<NiyahActivityAttributes>

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      BlobBadge(assetName: context.attributes.blobAssetName, size: 48)

      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(context.attributes.sessionType == "group" ? "Group session" : "Focus")
            .font(.caption)
            .foregroundColor(.secondary)
          Spacer()
          TimerLabel(endsAt: context.state.endsAt, size: 22, weight: .bold)
        }

        if !context.state.leaderboard.isEmpty {
          ForEach(context.state.leaderboard.prefix(3), id: \.name) { entry in
            LeaderboardRow(entry: entry)
          }
        }

        if context.state.userPayoutCents > 0 {
          Text("Your share: $\(payoutString(context.state.userPayoutCents))")
            .font(.caption)
            .foregroundColor(.green)
        }
      }
    }
  }

  private func payoutString(_ cents: Int) -> String {
    String(format: "%.2f", Double(cents) / 100.0)
  }
}

@available(iOS 16.1, *)
struct TimerLabel: View {
  let endsAt: Double
  let size: CGFloat
  let weight: Font.Weight

  var body: some View {
    let endDate = Date(timeIntervalSince1970: endsAt)
    Text(timerInterval: Date()...endDate, countsDown: true)
      .font(.system(size: size, weight: weight, design: .rounded))
      .monospacedDigit()
      .foregroundColor(.white)
  }
}

@available(iOS 16.1, *)
struct BlobBadge: View {
  let assetName: String
  let size: CGFloat

  var body: some View {
    Image(assetName)
      .resizable()
      .scaledToFit()
      .frame(width: size, height: size)
  }
}

@available(iOS 16.1, *)
struct LeaderboardRow: View {
  let entry: NiyahActivityAttributes.LeaderboardEntry

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(statusColor)
        .frame(width: 6, height: 6)
      Text(entry.name)
        .font(.caption)
        .foregroundColor(.white)
      Spacer()
      if entry.violations > 0 {
        Text("\(entry.violations)x")
          .font(.caption2)
          .foregroundColor(.orange)
      }
    }
  }

  private var statusColor: Color {
    switch entry.status {
    case "active": return .green
    case "completed": return .blue
    case "surrendered": return .red
    default: return .gray
    }
  }
}
