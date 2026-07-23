import AppKit
import Combine
import SwiftUI

private final class MamachiPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Floating overlay window: borderless and movable. Its collapsed and
/// expanded dimensions come only from persistent Settings presets.
@MainActor
final class OverlayPanelController: NSObject, NSWindowDelegate {
    private enum Metrics {
        static let compactFrameKey = "overlayCompactFrame"
        static let expandedFrameKey = "overlayExpandedFrame"
    }

    private let panel: MamachiPanel
    private var expanded: Bool
    private var expansionSubscription: AnyCancellable?
    private var collapsedSize: NSSize
    private var expandedSize: NSSize
    private var restoringFrame = false

    init(model: AppModel) {
        collapsedSize = NSSize(
            width: model.collapsedOverlaySize.collapsedSize.width,
            height: model.collapsedOverlaySize.collapsedSize.height
        )
        expandedSize = NSSize(
            width: model.expandedOverlaySize.expandedSize.width,
            height: model.expandedOverlaySize.expandedSize.height
        )
        expanded = model.drawerExpanded
        panel = MamachiPanel(
            contentRect: NSRect(origin: .zero, size: collapsedSize),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isMovableByWindowBackground = true
        panel.delegate = self

        let hosting = NSHostingView(rootView: OverlayView(model: model))
        // Settings owns both mode sizes; SwiftUI must not derive window dimensions.
        hosting.sizingOptions = []
        panel.contentView = hosting

        applyModeConstraints()

        expansionSubscription = model.$drawerExpanded
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] expanded in self?.scheduleModeChange(expanded: expanded) }
    }

    func show() {
        if !panel.isVisible {
            panel.setFrame(clamp(initialFrame(for: expanded)), display: false)
        }
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    func toggleVisibility() {
        panel.isVisible ? hide() : show()
    }

    /// Forgets saved positions and recenters at the selected mode size.
    func resetFrame() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Metrics.compactFrameKey)
        defaults.removeObject(forKey: Metrics.expandedFrameKey)
        let frame = clamp(defaultFrame(for: expanded))
        panel.setFrame(frame, display: true, animate: panel.isVisible)
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func applySizePresets(
        collapsed collapsedPreset: OverlaySizePreset,
        expanded expandedPreset: OverlaySizePreset
    ) {
        collapsedSize = NSSize(
            width: collapsedPreset.collapsedSize.width,
            height: collapsedPreset.collapsedSize.height
        )
        expandedSize = NSSize(
            width: expandedPreset.expandedSize.width,
            height: expandedPreset.expandedSize.height
        )

        let center = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
        let size = defaultSize(for: expanded)
        let frame = clamp(
            NSRect(
                x: center.x - size.width / 2,
                y: center.y - size.height / 2,
                width: size.width,
                height: size.height
            )
        )
        restoringFrame = true
        applyModeConstraints()
        panel.setFrame(frame, display: true)
        restoringFrame = false
        persistFrame()
    }

    func makeKeyForTyping() {
        guard panel.isVisible else { return }
        panel.makeKey()
    }

    // MARK: - Mode transitions

    private func scheduleModeChange(expanded: Bool) {
        transition(to: expanded)
    }

    private func transition(to nextExpanded: Bool) {
        guard nextExpanded != expanded else { return }
        persistFrame()
        let center = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
        expanded = nextExpanded
        let size = defaultSize(for: nextExpanded)
        let frame = clamp(
            NSRect(
                x: center.x - size.width / 2,
                y: center.y - size.height / 2,
                width: size.width,
                height: size.height
            )
        )
        restoringFrame = true
        applyModeConstraints()
        panel.setFrame(frame, display: true)
        restoringFrame = false
        persistFrame()
        if nextExpanded { panel.makeKey() }
    }

    private func applyModeConstraints() {
        let size = defaultSize(for: expanded)
        panel.contentAspectRatio = expanded ? .zero : NSSize(width: 1, height: 1)
        panel.contentMinSize = size
        panel.contentMaxSize = size
    }

    // MARK: - Frames

    private func defaultSize(for expanded: Bool) -> NSSize {
        expanded ? expandedSize : collapsedSize
    }

    private func defaultFrame(for expanded: Bool) -> NSRect {
        let size = defaultSize(for: expanded)
        guard let screen = panel.screen ?? NSScreen.main ?? NSScreen.screens.first else {
            return NSRect(origin: .zero, size: size)
        }
        let visible = screen.visibleFrame
        return NSRect(
            x: visible.midX - size.width / 2,
            y: visible.minY + 42,
            width: size.width,
            height: size.height
        )
    }

    private func initialFrame(for expanded: Bool) -> NSRect {
        guard let saved = savedFrame(for: expanded) else {
            return defaultFrame(for: expanded)
        }
        let size = defaultSize(for: expanded)
        return NSRect(
            x: saved.midX - size.width / 2,
            y: saved.midY - size.height / 2,
            width: size.width,
            height: size.height
        )
    }

    private func savedFrame(for expanded: Bool) -> NSRect? {
        let key = expanded ? Metrics.expandedFrameKey : Metrics.compactFrameKey
        guard let stored = UserDefaults.standard.string(forKey: key) else { return nil }
        let frame = NSRectFromString(stored)
        guard frame.width >= 80, frame.height >= 20 else { return nil }
        return frame
    }


    private func persistFrame() {
        guard panel.isVisible, !restoringFrame else { return }
        let key = expanded ? Metrics.expandedFrameKey : Metrics.compactFrameKey
        UserDefaults.standard.set(NSStringFromRect(panel.frame), forKey: key)
    }

    /// Keeps the window inside the visible frame of its nearest screen.
    private func clamp(_ frame: NSRect) -> NSRect {
        guard let screen = screenContaining(frame) else { return frame }
        let visible = screen.visibleFrame
        var result = frame
        result.size.width = min(result.width, visible.width)
        result.size.height = min(result.height, visible.height)
        result.origin.x = min(max(result.minX, visible.minX), visible.maxX - result.width)
        result.origin.y = min(max(result.minY, visible.minY), visible.maxY - result.height)
        return result
    }

    private func screenContaining(_ frame: NSRect) -> NSScreen? {
        let center = NSPoint(x: frame.midX, y: frame.midY)
        return NSScreen.screens.first(where: { NSPointInRect(center, $0.frame) })
            ?? panel.screen
            ?? NSScreen.main
            ?? NSScreen.screens.first
    }

    // MARK: - NSWindowDelegate

    nonisolated func windowDidMove(_ notification: Notification) {
        Task { @MainActor in self.persistFrame() }
    }

}

struct OrbContextMenuActions {
    let openTaskDrawer: () -> Void
    let openChat: () -> Void
    let openSettings: () -> Void
    let hideOverlay: () -> Void
    let quitApplication: () -> Void
}

/// Transparent AppKit layer that makes its whole area a window drag handle
/// while preserving clicks: a press that never travels acts as a click, a
/// press that moves performs a native window drag. Right-click is separate.
struct WindowDragHandle: NSViewRepresentable {
    var onClick: () -> Void
    var contextMenuActions: OrbContextMenuActions?

    func makeNSView(context: Context) -> DragHandleView {
        let view = DragHandleView()
        view.onClick = onClick
        view.contextMenuActions = contextMenuActions
        return view
    }

    func updateNSView(_ view: DragHandleView, context: Context) {
        view.onClick = onClick
        view.contextMenuActions = contextMenuActions
    }

    final class DragHandleView: NSView {
        var onClick: (() -> Void)?
        var contextMenuActions: OrbContextMenuActions?

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            let originBefore = window.frame.origin
            window.performDrag(with: event)
            let originAfter = window.frame.origin
            let travelled = hypot(originAfter.x - originBefore.x, originAfter.y - originBefore.y)
            if travelled < 3 { onClick?() }
        }

        override func rightMouseDown(with event: NSEvent) {
            guard contextMenuActions != nil else {
                super.rightMouseDown(with: event)
                return
            }
            NSMenu.popUpContextMenu(makeContextMenu(), with: event, for: self)
        }

        func makeContextMenu() -> NSMenu {
            let menu = NSMenu(title: "Mamachi")
            menu.autoenablesItems = false
            menu.addItem(menuItem("Open Task Drawer", action: #selector(openTaskDrawer)))
            menu.addItem(menuItem("Open Chat", action: #selector(openChat)))
            menu.addItem(.separator())
            menu.addItem(menuItem("Settings…", action: #selector(openSettings)))
            menu.addItem(menuItem("Hide Overlay", action: #selector(hideOverlay)))
            menu.addItem(.separator())
            menu.addItem(menuItem("Quit Mamachi", action: #selector(quitApplication)))
            return menu
        }

        private func menuItem(_ title: String, action: Selector) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            return item
        }

        @objc private func openTaskDrawer() {
            contextMenuActions?.openTaskDrawer()
        }

        @objc private func openChat() {
            contextMenuActions?.openChat()
        }

        @objc private func openSettings() {
            contextMenuActions?.openSettings()
        }

        @objc private func hideOverlay() {
            contextMenuActions?.hideOverlay()
        }

        @objc private func quitApplication() {
            contextMenuActions?.quitApplication()
        }
    }
}
