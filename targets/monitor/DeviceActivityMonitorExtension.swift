import DeviceActivity
import ManagedSettings
import FamilyControls
import Foundation

/// DeviceActivityMonitor App Extension. iOS launches in a separate process
/// when monitored activity events fire (interval start/end, threshold).
/// Class name MUST stay `DeviceActivityMonitorExtension` — that's the
/// NSExtensionPrincipalClass apple-targets writes into Info.plist
/// (`$(PRODUCT_MODULE_NAME).DeviceActivityMonitorExtension`).

@available(iOS 16.0, *)
extension ManagedSettingsStore.Name {
  static let niyahSession = Self("niyah.session")
}

@available(iOS 16.0, *)
class DeviceActivityMonitorExtension: DeviceActivityMonitor {

  private static let appGroupID = "group.com.niyah.app"
  private static let selectionKey = "niyah_app_selection"
  private static let violationsKey = "niyah_shield_violations"
  private static let blockingKey = "niyah_is_blocking"

  private var sharedDefaults: UserDefaults {
    UserDefaults(suiteName: Self.appGroupID) ?? .standard
  }

  override func intervalDidStart(for activity: DeviceActivityName) {
    super.intervalDidStart(for: activity)
    applyShieldsFromSavedSelection()
    sharedDefaults.set(true, forKey: Self.blockingKey)
  }

  override func intervalDidEnd(for activity: DeviceActivityName) {
    super.intervalDidEnd(for: activity)
    let store = ManagedSettingsStore(named: .niyahSession)
    store.clearAllSettings()
    sharedDefaults.set(false, forKey: Self.blockingKey)
  }

  override func eventDidReachThreshold(
    _ event: DeviceActivityEvent.Name,
    activity: DeviceActivityName
  ) {
    super.eventDidReachThreshold(event, activity: activity)
    guard sharedDefaults.bool(forKey: Self.blockingKey) else { return }
    recordViolation()
  }

  override func intervalWillStartWarning(for activity: DeviceActivityName) {
    super.intervalWillStartWarning(for: activity)
  }

  override func intervalWillEndWarning(for activity: DeviceActivityName) {
    super.intervalWillEndWarning(for: activity)
  }

  private func applyShieldsFromSavedSelection() {
    let store = ManagedSettingsStore(named: .niyahSession)
    guard let data = sharedDefaults.data(forKey: Self.selectionKey),
          let selection = try? PropertyListDecoder().decode(
            FamilyActivitySelection.self, from: data
          )
    else { return }

    if !selection.applicationTokens.isEmpty {
      store.shield.applications = selection.applicationTokens
    }
    if !selection.categoryTokens.isEmpty {
      store.shield.applicationCategories =
        ShieldSettings.ActivityCategoryPolicy.specific(selection.categoryTokens)
    }
    if !selection.webDomainTokens.isEmpty {
      store.shield.webDomains = selection.webDomainTokens
    }
  }

  private func recordViolation() {
    var violations = sharedDefaults.array(forKey: Self.violationsKey) as? [Double] ?? []
    violations.append(Date().timeIntervalSince1970 * 1000)
    sharedDefaults.set(violations, forKey: Self.violationsKey)
  }
}
