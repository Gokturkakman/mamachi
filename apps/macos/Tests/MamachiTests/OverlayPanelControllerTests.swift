import AppKit
import XCTest
@testable import Mamachi

@MainActor
final class OverlayPanelControllerTests: XCTestCase {
    func testCompactResizeStepsStaySquareClampAndPreserveCenter() {
        let current = NSRect(x: 100, y: 200, width: 144, height: 144)

        let larger = OverlayPanelController.compactFrame(from: current, resizingBy: 32)
        XCTAssertEqual(larger.width, 176, accuracy: 0.001)
        XCTAssertEqual(larger.height, 176, accuracy: 0.001)
        XCTAssertEqual(larger.midX, current.midX, accuracy: 0.001)
        XCTAssertEqual(larger.midY, current.midY, accuracy: 0.001)

        let smallest = OverlayPanelController.compactFrame(from: current, resizingBy: -1_000)
        XCTAssertEqual(smallest.width, 112, accuracy: 0.001)
        XCTAssertEqual(smallest.height, 112, accuracy: 0.001)
        XCTAssertEqual(smallest.midX, current.midX, accuracy: 0.001)
        XCTAssertEqual(smallest.midY, current.midY, accuracy: 0.001)

        let largest = OverlayPanelController.compactFrame(from: current, resizingBy: 1_000)
        XCTAssertEqual(largest.width, 300, accuracy: 0.001)
        XCTAssertEqual(largest.height, 300, accuracy: 0.001)
        XCTAssertEqual(largest.midX, current.midX, accuracy: 0.001)
        XCTAssertEqual(largest.midY, current.midY, accuracy: 0.001)
    }

    func testAppModelForwardsCompactResizeRequest() {
        let model = AppModel()
        var received: CGFloat?
        model.onAdjustCompactOrbSize = { received = $0 }

        model.adjustCompactOrbSize(by: 32)

        XCTAssertEqual(received, 32)
    }

    func testCompactResizeSurvivesExpandAndCollapseWithoutLargeIntermediateFrame() {
        let model = AppModel()
        let controller = OverlayPanelController(model: model)
        controller.resetFrame()
        defer {
            controller.resetFrame()
            controller.hide()
        }

        controller.adjustCompactOrbSize(by: 32)
        let compactFrame = panel(from: controller).frame

        model.drawerExpanded = true
        XCTAssertGreaterThanOrEqual(panel(from: controller).frame.width, 440)

        model.drawerExpanded = false
        let restoredFrame = panel(from: controller).frame
        XCTAssertEqual(restoredFrame.width, compactFrame.width, accuracy: 0.001)
        XCTAssertEqual(restoredFrame.height, compactFrame.height, accuracy: 0.001)
        XCTAssertLessThanOrEqual(restoredFrame.width, 300)
    }


    func testCompactSizePersistsAcrossRepeatedCyclesAndControllerRecreation() async {
        let model = AppModel()
        let controller = OverlayPanelController(model: model)
        var replacement: OverlayPanelController?
        controller.resetFrame()
        defer {
            replacement?.resetFrame()
            replacement?.hide()
            controller.resetFrame()
            controller.hide()
        }

        controller.adjustCompactOrbSize(by: -32)
        let chosenSize = panel(from: controller).frame.width

        for _ in 0..<3 {
            model.drawerExpanded = true
            await Task.yield()
            model.drawerExpanded = false
            await Task.yield()
        }
        XCTAssertEqual(panel(from: controller).frame.width, chosenSize, accuracy: 0.001)

        // Position persistence must not be able to overwrite the explicit size
        // selected with the plus/minus controls.
        var staleFrame = panel(from: controller).frame
        staleFrame.size = NSSize(width: 300, height: 300)
        UserDefaults.standard.set(NSStringFromRect(staleFrame), forKey: "overlayCompactFrame")

        controller.hide()
        let replacementModel = AppModel()
        let nextController = OverlayPanelController(model: replacementModel)
        replacement = nextController
        nextController.show()

        XCTAssertEqual(panel(from: nextController).frame.width, chosenSize, accuracy: 0.001)
    }

    private func panel(from controller: OverlayPanelController) -> NSPanel {
        guard let panel = Mirror(reflecting: controller).descendant("panel") as? NSPanel else {
            fatalError("OverlayPanelController panel is unavailable")
        }
        return panel
    }
}
