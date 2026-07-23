import AppKit
import SwiftUI

@MainActor
final class OnboardingPanelController {
    private let window: NSWindow
    private let onboarding: OnboardingModel

    init(model: AppModel, onComplete: @escaping () -> Void) {
        var completion: (() -> Void)?
        onboarding = OnboardingModel(appModel: model) { completion?() }
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 620),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = "Welcome to Mamachi"
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = NSHostingView(rootView: OnboardingView(onboarding: onboarding))
        completion = { [weak window] in
            window?.orderOut(nil)
            onComplete()
        }
    }

    func show() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }
}
