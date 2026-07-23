import XCTest
@testable import Mamachi

final class AppModelControlTests: XCTestCase {
    @MainActor
    func testMuteMicrophoneDisengagesListeningWithoutDisconnectingVoice() {
        let model = AppModel()
        model.isEngaged = true
        model.voiceState = .listening
        model.microphoneLevel = 0.7

        model.muteMicrophone()

        XCTAssertFalse(model.isEngaged)
        XCTAssertEqual(model.voiceState, .connected)
        XCTAssertEqual(model.microphoneLevel, 0)
    }

    @MainActor
    func testOverlayRecoveryActionsForwardToApplicationDelegate() {
        let model = AppModel()
        var didHide = false
        var didQuit = false
        model.onHideOverlay = { didHide = true }
        model.onQuitApplication = { didQuit = true }

        model.hideOverlay()
        model.quitApplication()

        XCTAssertTrue(didHide)
        XCTAssertTrue(didQuit)
    }

    @MainActor
    func testComputerControlProfilesPersistAndRemainCustomizable() {
        preservingComputerControlDefaults {
            let defaults = UserDefaults.standard
            defaults.removeObject(forKey: "computerCapabilities")
            defaults.removeObject(forKey: "computerConfirmationMode")

            let initial = AppModel()
            XCTAssertEqual(initial.computerCapabilities, ComputerCapability.assistive)
            XCTAssertEqual(initial.computerConfirmationMode, .sensitive)

            initial.updateComputerControlSettings(
                capabilities: ComputerCapability.full,
                confirmationMode: .never
            )
            let restored = AppModel()
            XCTAssertEqual(ComputerControlProfile.matching(restored.computerCapabilities), .full)
            XCTAssertEqual(restored.computerConfirmationMode, .never)

            var customized = restored.computerCapabilities
            customized.remove(.shell)
            restored.updateComputerControlSettings(
                capabilities: customized,
                confirmationMode: .always
            )
            XCTAssertEqual(ComputerControlProfile.matching(restored.computerCapabilities), .custom)
            XCTAssertEqual(restored.computerConfirmationMode, .always)
        }
    }

    private func preservingComputerControlDefaults(_ body: () -> Void) {
        let defaults = UserDefaults.standard
        let priorCapabilities = defaults.object(forKey: "computerCapabilities")
        let priorConfirmationMode = defaults.object(forKey: "computerConfirmationMode")
        defer {
            if let priorCapabilities {
                defaults.set(priorCapabilities, forKey: "computerCapabilities")
            } else {
                defaults.removeObject(forKey: "computerCapabilities")
            }
            if let priorConfirmationMode {
                defaults.set(priorConfirmationMode, forKey: "computerConfirmationMode")
            } else {
                defaults.removeObject(forKey: "computerConfirmationMode")
            }
        }
        body()
    }
}
