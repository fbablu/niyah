import Foundation
import ManagedSettings
import UserNotifications

// The named ManagedSettingsStore is shared by name across processes within
// the same team. Both the main app and this extension must use the same
// name to read/write the same shield state — that's how we can clear the
// shields from this extension when the user surrenders.
extension ManagedSettingsStore.Name {
    static let niyahSession = Self("niyah.session")
}

/// Handles user interactions with the Niyah shield screen.
///
/// Primary button   "Stay Focused"      → returns user to home screen, blocking
///                                        stays active so the next launch is
///                                        also blocked.
/// Secondary button "Surrender Session" → clears the shield immediately (so
///                                        the user can use their apps again),
///                                        writes a flag to shared UserDefaults
///                                        so the main app processes the
///                                        surrender on next foreground, and
///                                        attempts to launch the main app via
///                                        a custom URL scheme.
class NiyahShieldActionExtension: ShieldActionDelegate {

    // ── Shared storage ─────────────────────────────────────────────────────────
    private static let appGroupID            = "group.com.niyah.app"
    // Legacy auto-fire flag — only set as fallback when scheduling the
    // two-step confirm push fails (e.g. notification permission revoked).
    private static let surrenderKey          = "niyah_surrender_requested"
    // New two-step flag — set when the user taps "Surrender Session" so the
    // app knows a confirm is in-flight if the user opens it without the push.
    private static let pendingSurrenderKey   = "niyah_surrender_pending"
    private static let blockingKey           = "niyah_is_blocking"
    private static let surrenderPushID       = "niyah-surrender-confirm"
    private static let surrenderCategoryID   = "SURRENDER_CONFIRM"

    private var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: Self.appGroupID) ?? .standard
    }

    // ── ShieldActionDelegate overrides ─────────────────────────────────────────

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

    // ── Shared handler ─────────────────────────────────────────────────────────

    private func handleAction(
        _ action: ShieldAction,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        switch action {
        case .primaryButtonPressed:
            // "Stay Focused" — return user to Home Screen. Blocking stays active.
            completionHandler(.close)

        case .secondaryButtonPressed:
            // Two-step surrender (Lane B5):
            //   1. Flip the pending flag so the app knows a confirm is in-flight.
            //   2. Schedule a local push titled "Confirm surrender" with
            //      category SURRENDER_CONFIRM. The user must tap the push to
            //      deep-link into /session/active?confirmSurrender=true.
            //   3. Do NOT auto-open the app and do NOT clear the shield.
            //   4. If push scheduling fails (permission revoked, etc.), fall
            //      back to the legacy auto-open flow so the user is never
            //      stranded with no way to surrender.
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

    /// Schedules a local notification asking the user to confirm surrender.
    /// The category SURRENDER_CONFIRM is registered by the main app on launch
    /// so the system shows a "Confirm forfeit" action button on the push.
    private func scheduleSurrenderConfirmPush(completion: @escaping (Bool) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = "Confirm surrender"
        content.body = "Tap to forfeit your stake. This cannot be undone."
        content.sound = .default
        content.categoryIdentifier = Self.surrenderCategoryID
        content.userInfo = ["type": "surrender_confirm_pending"]

        // Tiny delay so iOS reliably delivers the push after the shield closes.
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

    /// Opens the Niyah main app from within the shield extension process.
    ///
    /// The documented Apple API does NOT support launching the host app from
    /// a ShieldActionExtension — the only officially supported responses are
    /// `.close`, `.defer`, and `.none`. However, instantiating a fresh
    /// `NSExtensionContext` and calling `open(_:completionHandler:)` on it
    /// bypasses that restriction. This is the same trick used by Opal and
    /// the widely-adopted kingstinct library.
    private func openMainApp(urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSExtensionContext().open(url) { _ in }
    }
}
