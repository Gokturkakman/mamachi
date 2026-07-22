import AppKit
import Combine
import QuartzCore
import SwiftUI

private final class MamachiPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class OverlayPanelController {
    private let panel: MamachiPanel
    private var expansionSubscription: AnyCancellable?

    init(model: AppModel) {
        panel = MamachiPanel(
            contentRect: NSRect(x: 0, y: 0, width: 144, height: 144),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isMovableByWindowBackground = true
        panel.contentView = NSHostingView(rootView: OverlayView(model: model))

        expansionSubscription = model.$drawerExpanded
            .removeDuplicates()
            .sink { [weak self] expanded in self?.resize(expanded: expanded) }
    }

    func show() {
        positionIfNeeded()
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    func toggleVisibility() {
        panel.isVisible ? hide() : show()
    }

    private func resize(expanded: Bool) {
        let newSize = expanded
            ? NSSize(width: 512, height: 652)
            : NSSize(width: 144, height: 144)
        var frame = panel.frame
        frame.origin.x -= (newSize.width - frame.width) / 2
        frame.origin.y -= (newSize.height - frame.height) / 2
        frame.size = newSize
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.38
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().setFrame(frame, display: true)
        }
    }

    private func positionIfNeeded() {
        guard !panel.isVisible, let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let frame = panel.frame
        let visible = screen.visibleFrame
        panel.setFrameOrigin(
            NSPoint(
                x: visible.midX - frame.width / 2,
                y: visible.minY + 42
            )
        )
    }
}
