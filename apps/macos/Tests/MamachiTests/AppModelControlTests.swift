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
}
