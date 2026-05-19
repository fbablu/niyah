import ManagedSettings
import ManagedSettingsUI
import UIKit

/// Class name MUST stay `ShieldConfigurationExtension` — apple-targets
/// writes `$(PRODUCT_MODULE_NAME).ShieldConfigurationExtension` into the
/// generated Info.plist as NSExtensionPrincipalClass.
class ShieldConfigurationExtension: ShieldConfigurationDataSource {

    private enum ShieldVariant {
        case social, video, gaming, news, defaultVariant
    }

    private let textPrimary   = UIColor(red: 242/255, green: 237/255, blue: 228/255, alpha: 1)
    private let textSecondary = UIColor(red: 170/255, green: 170/255, blue: 180/255, alpha: 1)
    private let primaryGreen  = UIColor(red: 45/255,  green: 106/255, blue: 79/255,  alpha: 1)
    private let accentGreen   = UIColor(red: 82/255,  green: 183/255, blue: 136/255, alpha: 1)
    private let dangerRed     = UIColor(red: 220/255, green: 60/255,  blue: 60/255,  alpha: 1)

    private func backgroundColor(for variant: ShieldVariant) -> UIColor {
        switch variant {
        case .social:         return UIColor(red: 36/255, green: 18/255, blue: 50/255, alpha: 1)
        case .video:          return UIColor(red: 12/255, green: 32/255, blue: 68/255, alpha: 1)
        case .gaming:         return UIColor(red: 14/255, green: 38/255, blue: 22/255, alpha: 1)
        case .news:           return UIColor(red: 42/255, green: 30/255, blue: 16/255, alpha: 1)
        case .defaultVariant: return UIColor(red: 15/255, green: 15/255, blue: 20/255, alpha: 1)
        }
    }

    private func iconName(for variant: ShieldVariant) -> String {
        switch variant {
        case .social:         return "person.2.fill"
        case .video:          return "play.rectangle.fill"
        case .gaming:         return "gamecontroller.fill"
        case .news:           return "newspaper.fill"
        case .defaultVariant: return "hourglass.circle.fill"
        }
    }

    private func icon(for variant: ShieldVariant) -> UIImage? {
        let config = UIImage.SymbolConfiguration(pointSize: 72, weight: .semibold)
        return UIImage(systemName: iconName(for: variant), withConfiguration: config)?
            .withTintColor(accentGreen, renderingMode: .alwaysOriginal)
    }

    private func detectVariant(bundleID: String?, categoryName: String?) -> ShieldVariant {
        if let bid = bundleID?.lowercased() {
            if bid.contains("instagram") || bid.contains("facebook") || bid.contains("snapchat")
                || bid.contains("tiktok") || bid.contains("threads") || bid.contains("bereal")
                || bid.contains("discord") || bid.contains("whatsapp") || bid.contains("messenger") {
                return .social
            }
            if bid.contains("youtube") || bid.contains("netflix") || bid.contains("hulu")
                || bid.contains("twitch") || bid.contains("disneyplus") || bid.contains("primevideo")
                || bid.contains("spotify") || bid.contains("apple.tv") {
                return .video
            }
            if bid.contains("supercell") || bid.contains("roblox") || bid.contains("fortnite")
                || bid.contains("genshin") || bid.contains("epicgames") || bid.contains("minecraft")
                || bid.contains("riotgames") || bid.contains("clashofclans") {
                return .gaming
            }
            if bid.contains("nytimes") || bid.contains("washingtonpost") || bid.contains("apple.news")
                || bid.contains("reddit") || bid.contains("twitter") || bid.contains("x.com")
                || bid.contains("hackernews") {
                return .news
            }
        }
        if let cat = categoryName?.lowercased() {
            if cat.contains("social") { return .social }
            if cat.contains("entertain") || cat.contains("video") { return .video }
            if cat.contains("game") { return .gaming }
            if cat.contains("news") { return .news }
        }
        return .defaultVariant
    }

    override func configuration(shielding application: Application) -> ShieldConfiguration {
        makeConfiguration(
            bundleID: application.bundleIdentifier,
            categoryName: nil
        )
    }

    override func configuration(
        shielding application: Application,
        in category: ActivityCategory
    ) -> ShieldConfiguration {
        makeConfiguration(
            bundleID: application.bundleIdentifier,
            categoryName: category.localizedDisplayName
        )
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        makeConfiguration(bundleID: nil, categoryName: nil)
    }

    override func configuration(
        shielding webDomain: WebDomain,
        in category: ActivityCategory
    ) -> ShieldConfiguration {
        makeConfiguration(
            bundleID: nil,
            categoryName: category.localizedDisplayName
        )
    }

    private let appGroupID = "group.com.niyah.app"
    private let sessionContextKey = "niyah_session_context"

    private func makeConfiguration(
        bundleID: String?,
        categoryName: String?
    ) -> ShieldConfiguration {
        let variant = detectVariant(bundleID: bundleID, categoryName: categoryName)
        let subtitleText = buildSubtitle(variant: variant)

        return ShieldConfiguration(
            backgroundBlurStyle: .systemUltraThinMaterialDark,
            backgroundColor: backgroundColor(for: variant),
            icon: icon(for: variant),
            title: ShieldConfiguration.Label(
                text: "Stay Focused",
                color: textPrimary
            ),
            subtitle: ShieldConfiguration.Label(
                text: subtitleText,
                color: textSecondary
            ),
            primaryButtonLabel: ShieldConfiguration.Label(
                text: "Back to Focus",
                color: .white
            ),
            primaryButtonBackgroundColor: primaryGreen,
            secondaryButtonLabel: ShieldConfiguration.Label(
                text: "Open Niyah →",
                color: dangerRed
            )
        )
    }

    private func buildSubtitle(variant: ShieldVariant) -> String {
        let context = readSessionContext()
        let names = context?["names"] as? [String]
        let stake = context?["stake"] as? Int ?? 0
        let stakeStr = stake > 0 ? String(format: "$%.2f", Double(stake) / 100.0) : nil

        let quotes = variantQuotes(
            variant,
            namesList: (names?.isEmpty == false) ? formatNames(names!) : nil,
            stakeStr: stakeStr
        )
        let index = Int(Date().timeIntervalSince1970 / 60) % quotes.count
        let lead = quotes[index]

        return "\(lead)\n\nUnlocking will forfeit your stake and return you to your home screen."
    }

    private func readSessionContext() -> [String: Any]? {
        guard let defaults = UserDefaults(suiteName: appGroupID),
              let json = defaults.string(forKey: sessionContextKey),
              let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return parsed
    }

    private func variantQuotes(_ variant: ShieldVariant, namesList: String?, stakeStr: String?) -> [String] {
        var quotes: [String] = baseQuotes(for: variant)
        if let names = namesList {
            quotes.append(contentsOf: socialQuotes(variant: variant, namesList: names))
        }
        if let stake = stakeStr {
            quotes.append(contentsOf: stakeQuotes(variant: variant, stakeStr: stake))
        }
        return quotes
    }

    private func baseQuotes(for variant: ShieldVariant) -> [String] {
        switch variant {
        case .social:
            return [
                "The scroll will still be here in an hour.\nYour future self won't be.",
                "Instagram is not your friend right now.\nYour focus session is.",
                "You opened this app on autopilot.\nThat's exactly what the algorithm wants.",
                "Every time you resist the scroll, the urge gets weaker.\nThis is one of those times.",
                "Whatever's happening in the feed will still be there.\nWhat you're working on won't.",
                "The dopamine hit lasts 30 seconds.\nThe regret lasts an hour.",
                "Your future self will thank you for closing this app right now.",
                "Nothing on this feed will help you reach the thing you actually want.",
                "You're not bored. You're avoiding.\nGet back to the work.",
                "Closing this app is the cheapest way to feel proud of yourself today.",
            ]
        case .video:
            return [
                "Just one video turns into an hour.\nClose it now and beat the pattern.",
                "YouTube doesn't care about your goals.\nYou do. Get back to them.",
                "Five-minute video, twenty-minute regret.\nYou know the math.",
                "Whatever's on Netflix will still be on Netflix tonight.",
                "The recommended row was made to keep you here.\nLeave anyway.",
                "Your eyes already feel heavy. That's the algorithm winning.",
                "Watching is not progress.\nClose the app and do the thing.",
                "The next video doesn't need you.\nThe person you want to become does.",
                "Streaming is fine. After the session.",
                "Twenty minutes of focus beats two hours of half-watched videos.",
            ]
        case .gaming:
            return [
                "One match becomes five.\nDon't even start.",
                "Your rank will recover tomorrow.\nThe lost hour won't.",
                "Closing the game right now is the move with the best EV.",
                "Your teammates will live without you for an hour.",
                "The grind is the game's design, not your goal.",
                "The boss will still be there.\nThe deadline might not be.",
                "Loot boxes are not life points.",
                "If this match isn't worth your stake, why is it worth your focus?",
                "The dopamine here is borrowed against tomorrow.\nDon't borrow more.",
                "Twenty minutes of work today, two hours of game tonight.\nDeal?",
            ]
        case .news:
            return [
                "Doomscrolling is not staying informed.",
                "The news will be there.\nThe headlines change but the urgency is fake.",
                "Twitter rewards outrage. Don't trade your focus for someone else's anger.",
                "Reddit is a slot machine in disguise.",
                "Your attention is the product.\nReclaim it.",
                "Nothing you read in the next ten minutes will change your day.",
                "The takes will still be hot tonight.",
                "Skimming feels productive. It isn't.",
                "Refreshing is the new fidgeting.\nDo something with your hands instead.",
                "Closing this beats one more refresh by a mile.",
            ]
        case .defaultVariant:
            return [
                "Real money is on the line.\nYour stake is safe as long as this app stays closed.",
                "The urge to open this app will pass.\nWait it out.",
                "You set the timer.\nPast-you knew what they were doing. Trust them.",
                "The cost of unlocking is real.\nThe payoff for closing is also real.",
                "Every minute you stay focused is money you keep.",
                "You won't remember this urge tomorrow.\nYou'll remember the work.",
                "Two more minutes. Then two more after that.",
                "The hardest part is the next 60 seconds.\nThen it gets easier.",
                "If past-you was wrong to stake this, prove them right.",
                "Close the app. Earn the stake. Move on.",
            ]
        }
    }

    private func socialQuotes(variant: ShieldVariant, namesList: String) -> [String] {
        switch variant {
        case .social:
            return [
                "\(namesList) are also resisting the scroll right now.\nDon't be the one who caves.",
                "\(namesList) put real money on this with you.\nClose the app.",
                "The whole group's focus stays clean if you close this now.",
            ]
        case .video:
            return [
                "\(namesList) just chose work over a video.\nYour turn.",
                "\(namesList) are watching the leaderboard, not Netflix.",
            ]
        case .gaming:
            return [
                "\(namesList) are not in the lobby. They're focused.\nFollow them.",
                "\(namesList) will know if you queued up.",
            ]
        case .news:
            return [
                "\(namesList) aren't doomscrolling. Be like them.",
            ]
        case .defaultVariant:
            return [
                "\(namesList) are counting on you.\nStay strong.",
                "\(namesList) will know if you open this app.\nDon't be the one who quits.",
                "Your friends are focusing right now.\n\(namesList) stayed off their phones — can you?",
            ]
        }
    }

    private func stakeQuotes(variant: ShieldVariant, stakeStr: String) -> [String] {
        switch variant {
        case .social:
            return [
                "\(stakeStr) for a scroll session?\nThe scroll is not that good.",
                "You staked \(stakeStr) so you wouldn't open this app.\nDon't outsmart past-you.",
            ]
        case .video:
            return [
                "\(stakeStr) is more than a month of YouTube Premium.\nKeep it.",
                "\(stakeStr) to watch the same recommendations again?",
            ]
        case .gaming:
            return [
                "\(stakeStr) is more than this season's battle pass.\nDon't trade focus for it.",
            ]
        case .news:
            return [
                "\(stakeStr) for one more outraged take?\nNot a great trade.",
            ]
        case .defaultVariant:
            return [
                "\(stakeStr) says you can't stay off this app.\nProve it wrong.",
                "You staked \(stakeStr).\nIt's still yours unless you tap forfeit.",
            ]
        }
    }

    private func formatNames(_ names: [String]) -> String {
        switch names.count {
        case 1: return names[0]
        case 2: return "\(names[0]) and \(names[1])"
        default:
            let allButLast = names.dropLast().joined(separator: ", ")
            return "\(allButLast), and \(names.last!)"
        }
    }
}
