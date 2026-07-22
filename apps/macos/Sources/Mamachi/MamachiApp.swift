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
            SettingsView(model: appDelegate.model, diagnostics: appDelegate.diagnostics)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    let diagnostics = DiagnosticsService()
    private var overlay: OverlayPanelController?
    private var settingsPanel: SettingsPanelController?
    private var onboardingPanel: OnboardingPanelController?
    private var hotKey: GlobalHotKey?
    private var launchStartedAt = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        launchStartedAt = Date()
        overlay = OverlayPanelController(model: model)
        settingsPanel = SettingsPanelController(model: model, diagnostics: diagnostics)
        model.onOpenSettings = { [weak self] in self?.showSettings() }
        model.onShowOverlay = { [weak self] in self?.showOverlay() }
        model.onResetOverlayFrame = { [weak self] in self?.overlay?.resetFrame() }
        model.onAdjustCompactOrbSize = { [weak self] points in
            self?.overlay?.adjustCompactOrbSize(by: points)
        }
        do {
            try ApplicationEncryptionService().prepareKey()
        } catch {
            model.errorMessage = error.localizedDescription
            diagnostics.recordFailure(component: .application, error: error)
        }

        if OnboardingModel.isComplete {
            startOperationalApp()
        } else {
            onboardingPanel = OnboardingPanelController(model: model) { [weak self] in
                self?.startOperationalApp()
            }
            onboardingPanel?.show()
        }
    }

    private func startOperationalApp() {
        NSApp.setActivationPolicy(.accessory)
        do {
            hotKey = try GlobalHotKey { [weak self] in
                guard let self else { return }
                showOverlay()
                model.toggleEngagement()
            }
        } catch {
            model.errorMessage = error.localizedDescription
            diagnostics.recordFailure(component: .application, error: error)
        }
        model.start()
        diagnostics.recordTransition(
            component: .application,
            from: .starting,
            to: .ready,
            elapsedMilliseconds: Int(Date().timeIntervalSince(launchStartedAt) * 1_000)
        )
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
