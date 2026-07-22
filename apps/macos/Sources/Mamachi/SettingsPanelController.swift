import AppKit
import SwiftUI

@MainActor
final class SettingsPanelController {
    private let window: NSWindow

    init(model: AppModel, diagnostics: DiagnosticsService) {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 800),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Mamachi Settings"
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = NSHostingView(rootView: SettingsView(model: model, diagnostics: diagnostics))
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }
}
