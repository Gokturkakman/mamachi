import AppKit
import XCTest
@testable import Mamachi

@MainActor
final class OverlayPanelControllerTests: XCTestCase {
    func testModelPersistsCollapsedAndExpandedPresetSelections() async {
        await preservingOverlayDefaults {
            let model = AppModel()
            var received: (OverlaySizePreset, OverlaySizePreset)?
            model.onOverlaySizeChange = { received = ($0, $1) }

            model.setCollapsedOverlaySize(.small)
            model.setExpandedOverlaySize(.large)

            XCTAssertEqual(model.collapsedOverlaySize, .small)
            XCTAssertEqual(model.expandedOverlaySize, .large)
            XCTAssertEqual(received?.0, .small)
            XCTAssertEqual(received?.1, .large)

            let replacement = AppModel()
            XCTAssertEqual(replacement.collapsedOverlaySize, .small)
            XCTAssertEqual(replacement.expandedOverlaySize, .large)
        }
    }

    func testSettingsPresetsControlBothModesAndPreserveAnchor() async {
        await preservingOverlayDefaults {
            let model = AppModel()
            model.setCollapsedOverlaySize(.small)
            model.setExpandedOverlaySize(.large)

            let controller = OverlayPanelController(model: model, animationDuration: 0)
            controller.resetFrame()
            defer { controller.hide() }
            model.onOverlaySizeChange = { [weak controller] collapsed, expanded in
                controller?.applySizePresets(collapsed: collapsed, expanded: expanded)
            }

            XCTAssertFalse(panel(from: controller).styleMask.contains(.resizable))
            assertPanel(controller, width: 116, height: 28)
            let stableAnchor = panelAnchor(from: controller)

            model.drawerExpanded = true
            await nextMainActorTurn()
            assertPanel(controller, width: 640, height: 800)
            assertAnchor(controller, equals: stableAnchor)

            model.drawerExpanded = false
            await nextMainActorTurn()
            assertPanel(controller, width: 116, height: 28)
            assertAnchor(controller, equals: stableAnchor)

            model.setCollapsedOverlaySize(.large)
            assertPanel(controller, width: 192, height: 38)
            assertAnchor(controller, equals: stableAnchor)

            model.setExpandedOverlaySize(.small)
            assertPanel(controller, width: 192, height: 38)

            model.drawerExpanded = true
            await nextMainActorTurn()
            assertPanel(controller, width: 440, height: 540)
            assertAnchor(controller, equals: stableAnchor)
            model.drawerExpanded = false
            await nextMainActorTurn()
            assertPanel(controller, width: 192, height: 38)
            assertAnchor(controller, equals: stableAnchor)

            controller.hide()
            UserDefaults.standard.set(
                NSStringFromRect(NSRect(x: 100, y: 100, width: 300, height: 300)),
                forKey: "overlayCompactFrame"
            )
            UserDefaults.standard.set(
                NSStringFromRect(NSRect(x: 100, y: 100, width: 860, height: 1020)),
                forKey: "overlayExpandedFrame"
            )

            let replacementModel = AppModel()
            let replacement = OverlayPanelController(model: replacementModel, animationDuration: 0)
            replacement.show()
            defer { replacement.hide() }

            assertPanel(replacement, width: 192, height: 38)
            let replacementAnchor = panelAnchor(from: replacement)
            replacementModel.drawerExpanded = true
            await nextMainActorTurn()
            assertPanel(replacement, width: 440, height: 540)
            assertAnchor(replacement, equals: replacementAnchor)
        }
    }

    func testRapidExpansionRequestsSettleAtFinalMode() async {
        await preservingOverlayDefaults {
            let model = AppModel()
            model.setCollapsedOverlaySize(.small)
            model.setExpandedOverlaySize(.small)
            let controller = OverlayPanelController(model: model, animationDuration: 0)
            controller.resetFrame()
            defer { controller.hide() }
            let stableAnchor = panelAnchor(from: controller)

            model.drawerExpanded = true
            model.drawerExpanded = false
            model.drawerExpanded = true
            await nextMainActorTurn()
            assertPanel(controller, width: 440, height: 540)
            assertAnchor(controller, equals: stableAnchor)

            model.drawerExpanded = false
            model.drawerExpanded = true
            model.drawerExpanded = false
            await nextMainActorTurn()
            assertPanel(controller, width: 116, height: 28)
            assertAnchor(controller, equals: stableAnchor)
        }
    }

    func testOverlayContextMenuProvidesRecoveryAndQuitActions() {
        var openedSettings = false
        var hidOverlay = false
        var quitApplication = false
        let view = WindowDragHandle.DragHandleView()
        view.contextMenuActions = OverlayContextMenuActions(
            openTaskDrawer: {},
            openChat: {},
            openSettings: { openedSettings = true },
            hideOverlay: { hidOverlay = true },
            quitApplication: { quitApplication = true }
        )

        let menu = view.makeContextMenu()
        XCTAssertEqual(
            menu.items.filter { !$0.isSeparatorItem }.map(\.title),
            ["Open Task Drawer", "Open Chat", "Settings…", "Hide Overlay", "Quit Mamachi"]
        )

        for title in ["Settings…", "Hide Overlay", "Quit Mamachi"] {
            guard
                let item = menu.items.first(where: { $0.title == title }),
                let action = item.action
            else {
                return XCTFail("Missing context-menu action for \(title)")
            }
            XCTAssertTrue(NSApplication.shared.sendAction(action, to: item.target, from: item))
        }
        XCTAssertTrue(openedSettings)
        XCTAssertTrue(hidOverlay)
        XCTAssertTrue(quitApplication)
    }

    private func assertAnchor(
        _ controller: OverlayPanelController,
        equals expected: NSPoint,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let actual = panelAnchor(from: controller)
        XCTAssertEqual(actual.x, expected.x, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(actual.y, expected.y, accuracy: 0.001, file: file, line: line)
    }

    private func panelAnchor(from controller: OverlayPanelController) -> NSPoint {
        let frame = panel(from: controller).frame
        return NSPoint(x: frame.midX, y: frame.minY)
    }

    private func assertPanel(
        _ controller: OverlayPanelController,
        width: CGFloat,
        height: CGFloat,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let frame = panel(from: controller).frame
        XCTAssertEqual(frame.width, width, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(frame.height, height, accuracy: 0.001, file: file, line: line)
    }

    private func preservingOverlayDefaults(_ body: () async -> Void) async {
        let defaults = UserDefaults.standard
        let keys = [
            "collapsedOverlaySizePreset",
            "expandedOverlaySizePreset",
            "overlayCompactFrame",
            "overlayExpandedFrame",
            "overlayAnchorV2",
        ]
        let previous = Dictionary(uniqueKeysWithValues: keys.map { ($0, defaults.object(forKey: $0)) })
        keys.forEach(defaults.removeObject(forKey:))
        defer {
            for key in keys {
                if let value = previous[key] {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        await body()
    }

    private func nextMainActorTurn() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }

    private func panel(from controller: OverlayPanelController) -> NSPanel {
        guard let panel = Mirror(reflecting: controller).descendant("panel") as? NSPanel else {
            fatalError("OverlayPanelController panel is unavailable")
        }
        return panel
    }
}
