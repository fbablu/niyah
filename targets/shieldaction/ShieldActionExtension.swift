import Foundation
import ManagedSettings
import UserNotifications

/// Class name MUST stay `ShieldActionExtension` — apple-targets writes
/// `$(PRODUCT_MODULE_NAME).ShieldActionExtension` into the generated
/// Info.plist as NSExtensionPrincipalClass.

extension ManagedSettingsStore.Name {
    static let niyahSession = Self("niyah.session")
}

class ShieldActionExtension: ShieldActionDelegate {

    private static let appGroupID            = "group.com.niyah.app"
    private static let surrenderKey          = "niyah_surrender_requested"
    private static let pendingSurrenderKey   = "niyah_surrender_pending"
    private static let blockingKey           = "niyah_is_blocking"
    private static let surrenderPushID       = "niyah-surrender-confirm"
    private static let surrenderCategoryID   = "SURRENDER_CONFIRM"

    private var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: Self.appGroupID) ?? .standard
    }

    override func handle(
        action: ShieldAction,
        for application: ApplicationToken,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        handleAction(action, completionHandler: completionHandler)
    }

    override func handle(
        action: ShieldAction,
        for webDomain: WebDomainToken,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        handleAction(action, completionHandler: completionHandler)
    }

    override func handle(
        action: ShieldAction,
        for category: ActivityCategoryToken,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        handleAction(action, completionHandler: completionHandler)
    }

    private func handleAction(
        _ action: ShieldAction,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        switch action {
        case .primaryButtonPressed:
            completionHandler(.close)

        case .secondaryButtonPressed:
            NSLog("[NiyahShieldAction] Surrender tapped — flipping pending flag, scheduling confirm push")
            sharedDefaults.set(true, forKey: Self.pendingSurrenderKey)
            sharedDefaults.synchronize()
            scheduleSurrenderConfirmPush { [self] scheduled in
                if !scheduled {
                    NSLog("[NiyahShieldAction] Push schedule failed — falling back to legacy auto-open")
                    sharedDefaults.set(true, forKey: Self.surrenderKey)
                    sharedDefaults.synchronize()
                    openMainApp(urlString: "niyah://surrender")
                }
                completionHandler(.close)
            }
            return

        @unknown default:
            completionHandler(.close)
        }
    }

    private func scheduleSurrenderConfirmPush(completion: @escaping (Bool) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = "Confirm surrender"
        content.body = "Tap to forfeit your stake. This cannot be undone."
        content.sound = .default
        content.categoryIdentifier = Self.surrenderCategoryID
        content.userInfo = ["type": "surrender_confirm_pending"]

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.5, repeats: false)
        let request = UNNotificationRequest(
            identifier: Self.surrenderPushID,
            content: content,
            trigger: trigger
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                NSLog("[NiyahShieldAction] Failed to schedule confirm push: \(error.localizedDescription)")
                completion(false)
            } else {
                completion(true)
            }
        }
    }

    private func openMainApp(urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSExtensionContext().open(url) { _ in }
    }
}
