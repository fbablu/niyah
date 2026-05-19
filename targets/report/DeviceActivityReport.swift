import DeviceActivity
import SwiftUI
import Foundation

/// DeviceActivityReport App Extension. Uses Swift `@main` so apple-targets'
/// generated Info.plist (default case, no NSExtensionPrincipalClass) is
/// sufficient — the `@main` annotation registers the entry point.

struct BaselineApp: Codable {
  let appBundleHash: String
  let displayName: String
  let categoryName: String
  let dailyAverageMinutes: Double
  let weeklyTotalMinutes: Double
}

struct BaselineSnapshot: Codable {
  let generatedAt: Double
  let apps: [BaselineApp]
}

@main
@available(iOS 16.0, *)
struct NiyahDeviceActivityReportExtension: DeviceActivityReportExtension {
  var body: some DeviceActivityReportScene {
    NiyahBaselineScene()
  }
}

@available(iOS 16.0, *)
struct NiyahBaselineScene: DeviceActivityReportScene {
  let context: DeviceActivityReport.Context = .init(rawValue: "niyahBaseline")
  let content: (BaselineSnapshot) -> NiyahBaselineView = { snapshot in
    NiyahBaselineView(snapshot: snapshot)
  }

  func makeConfiguration(
    representing data: DeviceActivityResults<DeviceActivityData>
  ) async -> BaselineSnapshot {
    var perApp: [String: BaselineApp] = [:]

    for await deviceData in data {
      let activeDays = 7

      for await segment in deviceData.activitySegments {
        for await category in segment.categories {
          let categoryName = category.category.localizedDisplayName ?? "Other"

          for await app in category.applications {
            let token = app.application
            let hashKey = String(token.hashValue)
            let displayName =
              token.localizedDisplayName ?? token.bundleIdentifier ?? "Unknown"
            let weeklyMinutes =
              app.totalActivityDuration / 60.0
            let dailyAvg = weeklyMinutes / Double(activeDays)

            if let existing = perApp[hashKey] {
              perApp[hashKey] = BaselineApp(
                appBundleHash: hashKey,
                displayName: existing.displayName,
                categoryName: existing.categoryName,
                dailyAverageMinutes:
                  existing.dailyAverageMinutes + dailyAvg,
                weeklyTotalMinutes:
                  existing.weeklyTotalMinutes + weeklyMinutes
              )
            } else {
              perApp[hashKey] = BaselineApp(
                appBundleHash: hashKey,
                displayName: displayName,
                categoryName: categoryName,
                dailyAverageMinutes: dailyAvg,
                weeklyTotalMinutes: weeklyMinutes
              )
            }
          }
        }
      }
    }

    let topApps = Array(
      perApp.values
        .sorted { $0.dailyAverageMinutes > $1.dailyAverageMinutes }
        .prefix(20)
    )

    let snapshot = BaselineSnapshot(
      generatedAt: Date().timeIntervalSince1970 * 1000,
      apps: topApps
    )

    let groupDefaults = UserDefaults(suiteName: "group.com.niyah.app")
    if let encoded = try? JSONEncoder().encode(snapshot) {
      groupDefaults?.set(encoded, forKey: "niyah_baseline_snapshot")
    }

    return snapshot
  }
}

@available(iOS 16.0, *)
struct NiyahBaselineView: View {
  let snapshot: BaselineSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Your top apps this week")
        .font(.headline)
      ForEach(snapshot.apps.prefix(5), id: \.appBundleHash) { app in
        HStack {
          Text(app.displayName)
          Spacer()
          Text("\(Int(app.dailyAverageMinutes))m/day")
            .foregroundColor(.secondary)
        }
      }
    }
    .padding()
  }
}
