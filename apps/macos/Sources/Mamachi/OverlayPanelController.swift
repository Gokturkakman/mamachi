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
        static let anchorKey = "overlayAnchorV2"
        static let legacyCompactFrameKey = "overlayCompactFrame"
        static let legacyExpandedFrameKey = "overlayExpandedFrame"
    }

    private let panel: MamachiPanel
    private let collapseHitTarget = WindowDragHandle.DragHandleView()
    private var expanded: Bool
    private var expansionSubscription: AnyCancellable?
    private var collapsedSize: NSSize
    private var expandedSize: NSSize
    private var anchor: NSPoint?
    private var updatingFrame = false

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
        panel.isMovableByWindowBackground = false
        panel.delegate = self

        let hosting = NSHostingView(rootView: OverlayView(model: model))
        hosting.sizingOptions = []
        hosting.frame = NSRect(origin: .zero, size: collapsedSize)
        hosting.autoresizingMask = [.width, .height]

        let container = NSView(frame: NSRect(origin: .zero, size: collapsedSize))
        container.autoresizesSubviews = true
        container.addSubview(hosting)

        collapseHitTarget.frame = NSRect(
            x: collapsedSize.width - 40,
            y: collapsedSize.height - 81,
            width: 36,
            height: 36
        )
        collapseHitTarget.autoresizingMask = [.minXMargin, .minYMargin]
        collapseHitTarget.isHidden = !expanded
        collapseHitTarget.onClick = { [weak model] in
            model?.drawerExpanded = false
        }
        container.addSubview(collapseHitTarget)
        panel.contentView = container

        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Metrics.legacyCompactFrameKey)
        defaults.removeObject(forKey: Metrics.legacyExpandedFrameKey)
        anchor = storedAnchor()
        applyModeConstraints()

        expansionSubscription = model.$drawerExpanded
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] nextExpanded in
                guard let self else { return }
                // @Published emits before storing. Capture the old frame's anchor now, then
                // defer resizing so SwiftUI reads the new state while rendering the new frame.
                let stableAnchor = self.resolvedAnchor()
                DispatchQueue.main.async { [weak self] in
                    self?.transition(to: nextExpanded, anchor: stableAnchor)
                }
            }
    }

    func show() {
        if !panel.isVisible {
            setFrame(for: expanded, anchor: resolvedAnchor(), display: false)
        }
        panel.orderFrontRegardless()
        persistAnchor()
    }

    func hide() {
        panel.orderOut(nil)
    }

    func toggleVisibility() {
        panel.isVisible ? hide() : show()
    }

    func resetFrame() {
        let resetAnchor = defaultAnchor()
        UserDefaults.standard.set(NSStringFromPoint(resetAnchor), forKey: Metrics.anchorKey)
        anchor = resetAnchor
        setFrame(for: expanded, anchor: resetAnchor, display: panel.isVisible)
        if !panel.isVisible { panel.orderFrontRegardless() }
        persistAnchor()
    }

    func applySizePresets(
        collapsed collapsedPreset: OverlaySizePreset,
        expanded expandedPreset: OverlaySizePreset
    ) {
        let stableAnchor = resolvedAnchor()
        collapsedSize = NSSize(
            width: collapsedPreset.collapsedSize.width,
            height: collapsedPreset.collapsedSize.height
        )
        expandedSize = NSSize(
            width: expandedPreset.expandedSize.width,
            height: expandedPreset.expandedSize.height
        )
        setFrame(for: expanded, anchor: stableAnchor, display: panel.isVisible)
    }

    func makeKeyForTyping() {
        guard panel.isVisible, expanded else { return }
        panel.makeKey()
    }

    // MARK: - Mode transitions

    private func transition(to nextExpanded: Bool, anchor stableAnchor: NSPoint) {
        guard nextExpanded != expanded else { return }
        collapseHitTarget.isHidden = !nextExpanded
        expanded = nextExpanded
        setFrame(for: nextExpanded, anchor: stableAnchor, display: panel.isVisible)
        if nextExpanded {
            panel.orderFrontRegardless()
            panel.makeKey()
        }
    }

    private func setFrame(for expanded: Bool, anchor requestedAnchor: NSPoint, display: Bool) {
        let target = clamp(frame(for: expanded, anchor: requestedAnchor))
        updatingFrame = true
        panel.contentAspectRatio = .zero
        panel.contentMinSize = .zero
        panel.contentMaxSize = NSSize(width: 10_000, height: 10_000)
        panel.setFrame(target, display: display)
        applyModeConstraints()
        updatingFrame = false
        anchor = frameAnchor(panel.frame)
        persistAnchor()
    }

    private func applyModeConstraints() {
        let size = defaultSize(for: expanded)
        panel.contentAspectRatio = .zero
        panel.contentMinSize = size
        panel.contentMaxSize = size
    }

    // MARK: - Stable bottom-center anchor

    private func defaultSize(for expanded: Bool) -> NSSize {
        expanded ? expandedSize : collapsedSize
    }

    private func frame(for expanded: Bool, anchor: NSPoint) -> NSRect {
        let size = defaultSize(for: expanded)
        return NSRect(
            x: anchor.x - size.width / 2,
            y: anchor.y,
            width: size.width,
            height: size.height
        )
    }

    private func frameAnchor(_ frame: NSRect) -> NSPoint {
        NSPoint(x: frame.midX, y: frame.minY)
    }

    private func resolvedAnchor() -> NSPoint {
        if panel.isVisible, !updatingFrame {
            let current = frameAnchor(panel.frame)
            anchor = current
            return current
        }
        if let anchor { return anchor }
        let fallback = defaultAnchor()
        anchor = fallback
        return fallback
    }

    private func defaultAnchor() -> NSPoint {
        guard let screen = panel.screen ?? NSScreen.main ?? NSScreen.screens.first else {
            return .zero
        }
        let visible = screen.visibleFrame
        return NSPoint(x: visible.midX, y: visible.minY + 42)
    }

    private func storedAnchor() -> NSPoint? {
        guard let stored = UserDefaults.standard.string(forKey: Metrics.anchorKey) else {
            return nil
        }
        let point = NSPointFromString(stored)
        guard point.x.isFinite, point.y.isFinite else { return nil }
        return NSScreen.screens.contains(where: { NSPointInRect(point, $0.frame) }) ? point : nil
    }

    private func persistAnchor() {
        guard panel.isVisible, !updatingFrame else { return }
        let current = frameAnchor(panel.frame)
        anchor = current
        UserDefaults.standard.set(NSStringFromPoint(current), forKey: Metrics.anchorKey)
    }

    // MARK: - Screen bounds

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
        Task { @MainActor in self.persistAnchor() }
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

        private var pressScreenLocation: NSPoint?
        private var pressWindowOrigin: NSPoint?
        private var didDrag = false

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func resetCursorRects() {
            addCursorRect(bounds, cursor: .pointingHand)
        }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            pressScreenLocation = window.convertPoint(toScreen: event.locationInWindow)
            pressWindowOrigin = window.frame.origin
            didDrag = false
        }

        override func mouseDragged(with event: NSEvent) {
            guard
                let window,
                let pressScreenLocation,
                let pressWindowOrigin
            else { return }
            let current = window.convertPoint(toScreen: event.locationInWindow)
            let deltaX = current.x - pressScreenLocation.x
            let deltaY = current.y - pressScreenLocation.y
            if !didDrag, hypot(deltaX, deltaY) < 3 { return }
            didDrag = true
            window.setFrameOrigin(
                NSPoint(x: pressWindowOrigin.x + deltaX, y: pressWindowOrigin.y + deltaY)
            )
        }

        override func mouseUp(with event: NSEvent) {
            defer {
                pressScreenLocation = nil
                pressWindowOrigin = nil
                didDrag = false
            }
            guard let window else { return }
            if !didDrag {
                onClick?()
                return
            }
            guard let screen = window.screen ?? NSScreen.main else { return }
            window.setFrame(window.constrainFrameRect(window.frame, to: screen), display: true)
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
