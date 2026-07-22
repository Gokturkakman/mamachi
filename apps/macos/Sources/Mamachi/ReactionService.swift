import AppKit
import UserNotifications

@MainActor
final class ReactionService: NSObject, UNUserNotificationCenterDelegate {
    var onOpen: (() -> Void)?

    private var center: UNUserNotificationCenter { .current() }

    func requestAuthorization() {
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func notify(
        id: String,
        title: String,
        body: String,
        notificationsEnabled: Bool,
        soundEnabled: Bool
    ) {
        guard notificationsEnabled else {
            if soundEnabled { NSSound(named: "Glass")?.play() }
            return
        }
        center.delegate = self
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if soundEnabled { content.sound = .default }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        completionHandler()
        Task { @MainActor [weak self] in self?.onOpen?() }
    }
}
