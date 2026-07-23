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
            Label(appDelegate.model.menuBarStatusText, systemImage: appDelegate.model.menuBarSystemImage)
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
    private var activationMonitor: KeyActivationMonitor?
    private var launchStartedAt = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        launchStartedAt = Date()
        overlay = OverlayPanelController(model: model)
        settingsPanel = SettingsPanelController(model: model, diagnostics: diagnostics)
        model.onOpenSettings = { [weak self] in self?.showSettings() }
        model.onShowOverlay = { [weak self] in self?.showOverlay() }
        model.onResetOverlayFrame = { [weak self] in self?.overlay?.resetFrame() }
        model.onOverlaySizeChange = { [weak self] collapsed, expanded in
            self?.overlay?.applySizePresets(collapsed: collapsed, expanded: expanded)
        }
        model.onHideOverlay = { [weak self] in self?.hideOverlay() }
        model.onQuitApplication = { NSApp.terminate(nil) }
        model.onActivationKeyChange = { [weak self] in self?.installActivationMonitor() }
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
        // Info.plist's LSUIElement owns the normal accessory policy. Changing
        // it after SwiftUI creates MenuBarExtra can tear down the status item.
        //
        // Primary wake gesture: bare-modifier tap monitor (Wispr-style).
        // `⌥Space` stays registered as a fallback that works without
        // Accessibility trust.
        installActivationMonitor()
        do {
            hotKey = try GlobalHotKey { [weak self] in
                guard let self else { return }
                showOverlay()
                model.toggleEngagement()
            }
        } catch {
            // If global recovery is unavailable, keep a Dock entry so the
            // application can still be activated and quit.
            _ = NSApp.setActivationPolicy(.regular)
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
        // Accessibility trust may have been granted since launch; opening
        // Settings is a natural moment to retry without polling TCC.
        if activationMonitor == nil { installActivationMonitor() }
        settingsPanel?.show()
    }

    private func installActivationMonitor() {
        activationMonitor = nil
        model.activationMonitorActive = false
        guard model.activationKey != .off else { return }
        guard let monitor = KeyActivationMonitor(
            key: model.activationKey,
            isEngaged: { [weak self] in self?.model.isEngaged ?? false },
            onVerdict: { [weak self] verdict in self?.model.handleActivation(verdict) }
        ) else { return }
        activationMonitor = monitor
        model.activationMonitorActive = true
    }
}
