import AppKit
import SwiftUI

@main
struct MamachiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(
                model: appDelegate.model,
                showOverlay: appDelegate.showOverlay,
                hideOverlay: appDelegate.hideOverlay
            )
        } label: {
            Label("Mamachi", systemImage: appDelegate.model.isEngaged ? "waveform.circle.fill" : "waveform.circle")
        }
        .menuBarExtraStyle(.menu)

        Settings {
            SettingsView(model: appDelegate.model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var overlay: OverlayPanelController?
    private var settingsPanel: SettingsPanelController?
    private var hotKey: GlobalHotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        overlay = OverlayPanelController(model: model)
        settingsPanel = SettingsPanelController(model: model)
        model.onOpenSettings = { [weak self] in self?.showSettings() }
        do {
            hotKey = try GlobalHotKey { [weak self] in
                guard let self else { return }
                showOverlay()
                model.toggleEngagement()
            }
        } catch {
            model.errorMessage = error.localizedDescription
        }
        model.start()
        showOverlay()
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.stop()
    }

    func showOverlay() {
        overlay?.show()
    }

    func hideOverlay() {
        overlay?.hide()
    }
    func showSettings() {
        settingsPanel?.show()
    }
}
