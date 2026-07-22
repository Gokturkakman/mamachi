import AppKit
import Combine
import SwiftUI

private final class MamachiPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Floating overlay window: borderless, non-activating, user-resizable.
/// The compact orb keeps a square aspect; both modes remember their frame.
@MainActor
final class OverlayPanelController: NSObject, NSWindowDelegate {
    private enum Metrics {
        static let compactDefault = NSSize(width: 144, height: 144)
        static let compactMin = NSSize(width: 112, height: 112)
        static let compactMax = NSSize(width: 300, height: 300)
        static let expandedDefault = NSSize(width: 512, height: 652)
        static let expandedMin = NSSize(width: 440, height: 540)
        static let expandedMax = NSSize(width: 860, height: 1020)
        static let compactFrameKey = "overlayCompactFrame"
        static let expandedFrameKey = "overlayExpandedFrame"
    }

    private let panel: MamachiPanel
    private var expanded: Bool
    private var expansionSubscription: AnyCancellable?
    private var restoringFrame = false

    init(model: AppModel) {
        expanded = model.drawerExpanded
        panel = MamachiPanel(
            contentRect: NSRect(origin: .zero, size: Metrics.compactDefault),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView, .resizable],
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
        // The window owns its size; SwiftUI must not fight user resizing.
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

    /// Forgets saved frames and recenters the overlay at its default size.
    func resetFrame() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Metrics.compactFrameKey)
        defaults.removeObject(forKey: Metrics.expandedFrameKey)
        let frame = clamp(defaultFrame(for: expanded))
        panel.setFrame(frame, display: true, animate: panel.isVisible)
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    /// Pure geometry used by the resize buttons and covered independently of
    /// AppKit window animation.
    static func compactFrame(from current: NSRect, resizingBy points: CGFloat) -> NSRect {
        let side = min(
            max(current.width + points, Metrics.compactMin.width),
            Metrics.compactMax.width
        )
        return NSRect(
            x: current.midX - side / 2,
            y: current.midY - side / 2,
            width: side,
            height: side
        )
    }

    /// Resizes the compact orb in large, predictable steps while keeping its
    /// center stable. Native edge resizing remains available as a fallback.
    func adjustCompactOrbSize(by points: CGFloat) {
        guard !expanded else { return }
        let current = panel.frame
        let resized = Self.compactFrame(from: current, resizingBy: points)
        guard abs(resized.width - current.width) > 0.5 else { return }
        let next = clamp(resized)
        panel.setFrame(next, display: true)
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
        applyModeConstraints()

        let size = savedFrame(for: nextExpanded)?.size ?? defaultSize(for: nextExpanded)
        let frame = clamp(
            NSRect(
                x: center.x - size.width / 2,
                y: center.y - size.height / 2,
                width: size.width,
                height: size.height
            )
        )
        restoringFrame = true
        panel.setFrame(frame, display: true)
        restoringFrame = false
        persistFrame()
        if nextExpanded { panel.makeKey() }
    }

    private func applyModeConstraints() {
        if expanded {
            panel.contentAspectRatio = .zero
            panel.contentMinSize = Metrics.expandedMin
            panel.contentMaxSize = Metrics.expandedMax
        } else {
            panel.contentAspectRatio = NSSize(width: 1, height: 1)
            panel.contentMinSize = Metrics.compactMin
            panel.contentMaxSize = Metrics.compactMax
        }
    }

    // MARK: - Frames

    private func defaultSize(for expanded: Bool) -> NSSize {
        expanded ? Metrics.expandedDefault : Metrics.compactDefault
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
        savedFrame(for: expanded) ?? defaultFrame(for: expanded)
    }

    private func savedFrame(for expanded: Bool) -> NSRect? {
        let key = expanded ? Metrics.expandedFrameKey : Metrics.compactFrameKey
        guard let stored = UserDefaults.standard.string(forKey: key) else { return nil }
        let frame = NSRectFromString(stored)
        guard frame.width >= 40, frame.height >= 40 else { return nil }
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

    nonisolated func windowDidEndLiveResize(_ notification: Notification) {
        Task { @MainActor in self.persistFrame() }
    }
}

/// Transparent AppKit layer that makes its whole area a window drag handle
/// while preserving clicks: a press that never travels acts as a click, a
/// press that moves performs a native window drag. Right-click is separate.
struct WindowDragHandle: NSViewRepresentable {
    var onClick: () -> Void
    var onRightClick: (() -> Void)?

    func makeNSView(context: Context) -> DragHandleView {
        let view = DragHandleView()
        view.onClick = onClick
        view.onRightClick = onRightClick
        return view
    }

    func updateNSView(_ view: DragHandleView, context: Context) {
        view.onClick = onClick
        view.onRightClick = onRightClick
    }

    final class DragHandleView: NSView {
        var onClick: (() -> Void)?
        var onRightClick: (() -> Void)?

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            let originBefore = window.frame.origin
            window.performDrag(with: event)
            let originAfter = window.frame.origin
            let travelled = hypot(originAfter.x - originBefore.x, originAfter.y - originBefore.y)
            if travelled < 3 { onClick?() }
        }

        override func rightMouseDown(with event: NSEvent) {
            guard let onRightClick else {
                super.rightMouseDown(with: event)
                return
            }
            onRightClick()
        }
    }
}
