import AppKit
import XCTest
@testable import Mamachi

@MainActor
final class OverlayPanelControllerTests: XCTestCase {
    func testModelPersistsCollapsedAndExpandedPresetSelections() {
        preservingOverlayDefaults {
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

    func testSettingsPresetsControlBothModesAndIgnoreSavedFrameDimensions() {
        preservingOverlayDefaults {
            let model = AppModel()
            model.setCollapsedOverlaySize(.small)
            model.setExpandedOverlaySize(.large)

            let controller = OverlayPanelController(model: model)
            controller.resetFrame()
            defer { controller.hide() }
            model.onOverlaySizeChange = { [weak controller] collapsed, expanded in
                controller?.applySizePresets(collapsed: collapsed, expanded: expanded)
            }

            XCTAssertFalse(panel(from: controller).styleMask.contains(.resizable))
            assertPanel(controller, width: 112, height: 112)

            model.drawerExpanded = true
            assertPanel(controller, width: 640, height: 800)

            model.drawerExpanded = false
            assertPanel(controller, width: 112, height: 112)

            model.setCollapsedOverlaySize(.large)
            assertPanel(controller, width: 184, height: 184)

            model.setExpandedOverlaySize(.small)
            assertPanel(controller, width: 184, height: 184)

            model.drawerExpanded = true
            assertPanel(controller, width: 440, height: 540)
            model.drawerExpanded = false
            assertPanel(controller, width: 184, height: 184)

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
            let replacement = OverlayPanelController(model: replacementModel)
            replacement.show()
            defer { replacement.hide() }

            assertPanel(replacement, width: 184, height: 184)
            replacementModel.drawerExpanded = true
            assertPanel(replacement, width: 440, height: 540)
        }
    }

    func testOrbContextMenuProvidesRecoveryAndQuitActions() {
        var openedSettings = false
        var hidOverlay = false
        var quitApplication = false
        let view = WindowDragHandle.DragHandleView()
        view.contextMenuActions = OrbContextMenuActions(
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

    private func preservingOverlayDefaults(_ body: () -> Void) {
        let defaults = UserDefaults.standard
        let keys = [
            "collapsedOverlaySizePreset",
            "expandedOverlaySizePreset",
            "overlayCompactFrame",
            "overlayExpandedFrame",
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
        body()
    }

    private func panel(from controller: OverlayPanelController) -> NSPanel {
        guard let panel = Mirror(reflecting: controller).descendant("panel") as? NSPanel else {
            fatalError("OverlayPanelController panel is unavailable")
        }
        return panel
    }
}
