import XCTest
@testable import Mamachi

/// Pure-clock tests for the bare-modifier gesture recognizer. Timestamps are
/// arbitrary uptime seconds; the machine never reads a real clock.
final class KeyActivationTests: XCTestCase {
    private var engaged = false

    private func makeMachine() -> ActivationGestureMachine {
        ActivationGestureMachine(isEngaged: { [weak self] in self?.engaged ?? false })
    }

    func testDoubleTapWhileAsleepEngagesOnSecondKeyDown() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 10.00))
        XCTAssertNil(machine.keyUp(at: 10.08))
        XCTAssertEqual(machine.keyDown(at: 10.20), .engageHandsFree)
        // The second press's release is consumed silently.
        XCTAssertNil(machine.keyUp(at: 10.28))
        XCTAssertNil(machine.pendingDeadline)
    }

    func testLoneTapWhileAsleepDoesNothing() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 5.00))
        XCTAssertNil(machine.keyUp(at: 5.10))
        guard let deadline = machine.pendingDeadline else {
            return XCTFail("tap should arm the double-tap window")
        }
        XCTAssertEqual(deadline, 5.10 + 0.35, accuracy: 0.001)
        XCTAssertNil(machine.deadlineElapsed(at: deadline))
        XCTAssertNil(machine.pendingDeadline)
    }

    func testSecondTapAfterWindowExpiryStartsFreshPress() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 1.00))
        XCTAssertNil(machine.keyUp(at: 1.10))
        // Timer never fired (grain), but the second press arrives late.
        XCTAssertNil(machine.keyDown(at: 2.00))
        // The late press behaves like a first press: hold deadline armed.
        XCTAssertEqual(machine.pendingDeadline ?? 0, 2.25, accuracy: 0.001)
    }

    func testHoldWhileAsleepBeginsAndEndsPushToTalk() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 3.00))
        guard let deadline = machine.pendingDeadline else {
            return XCTFail("press should arm the hold deadline")
        }
        XCTAssertEqual(deadline, 3.25, accuracy: 0.001)
        XCTAssertEqual(machine.deadlineElapsed(at: deadline), .beginPushToTalk)
        XCTAssertEqual(machine.keyUp(at: 4.40), .endPushToTalk)
    }

    func testComboPoisonsPressAndNeverFires() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 7.00))
        machine.otherKeyDown(at: 7.05) // Fn+arrow style combo
        // Hold deadline was cancelled: no push-to-talk.
        XCTAssertNil(machine.pendingDeadline)
        XCTAssertNil(machine.deadlineElapsed(at: 7.30))
        XCTAssertNil(machine.keyUp(at: 7.40))
        // No double-tap window armed either.
        XCTAssertNil(machine.pendingDeadline)
    }

    func testTypingCancelsPendingDoubleTap() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 8.00))
        XCTAssertNil(machine.keyUp(at: 8.05))
        machine.otherKeyDown(at: 8.10)
        // The next press is a fresh first press, not a second tap.
        XCTAssertNil(machine.keyDown(at: 8.15))
        XCTAssertEqual(machine.pendingDeadline ?? 0, 8.40, accuracy: 0.001)
    }

    func testCleanReleaseWhileEngagedFiresImmediately() {
        engaged = true
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 20.00))
        // No wake deadlines while engaged: stop acts on release, any duration.
        XCTAssertNil(machine.pendingDeadline)
        XCTAssertEqual(machine.keyUp(at: 20.60), .tapWhileEngaged)
    }

    func testComboWhileEngagedDoesNotStop() {
        engaged = true
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 21.00))
        machine.otherKeyDown(at: 21.05)
        XCTAssertNil(machine.keyUp(at: 21.10))
    }

    func testEngagementBranchIsFrozenAtPressTime() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 30.00))
        // Voice-side engagement flips mid-press (e.g. resumed session).
        engaged = true
        XCTAssertNil(machine.keyUp(at: 30.08))
        // Press began asleep, so it stays a wake tap: window armed, no stop.
        XCTAssertEqual(machine.pendingDeadline ?? 0, 30.08 + 0.35, accuracy: 0.001)
    }

    func testPushToTalkSurvivesOtherKeys() {
        let machine = makeMachine()
        XCTAssertNil(machine.keyDown(at: 40.00))
        XCTAssertEqual(machine.deadlineElapsed(at: 40.25), .beginPushToTalk)
        machine.otherKeyDown(at: 40.50) // typing while dictating
        XCTAssertEqual(machine.keyUp(at: 41.00), .endPushToTalk)
    }

    @MainActor
    func testHandleActivationMapsVerdictsOntoEngagement() {
        let model = AppModel()
        var shown = 0
        model.onShowOverlay = { shown += 1 }

        // Wake gestures raise the overlay; endPushToTalk sleeps the mic.
        model.isEngaged = true
        model.voiceState = .listening
        model.handleActivation(.endPushToTalk)
        XCTAssertFalse(model.isEngaged)
        XCTAssertEqual(model.voiceState, .connected)

        // tapWhileEngaged while not speaking sleeps the microphone.
        model.isEngaged = true
        model.voiceState = .listening
        model.handleActivation(.tapWhileEngaged)
        XCTAssertFalse(model.isEngaged)

        // Stale tap after engagement already ended is a no-op.
        model.handleActivation(.tapWhileEngaged)
        XCTAssertFalse(model.isEngaged)
        XCTAssertEqual(shown, 0)
    }

    @MainActor
    func testActivationKeyPersistsAndNotifies() {
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: "activationKey")
        defer {
            if let previous {
                defaults.set(previous, forKey: "activationKey")
            } else {
                defaults.removeObject(forKey: "activationKey")
            }
        }

        let model = AppModel()
        XCTAssertEqual(model.activationKey, .fn, "Fn is the default wake key")
        var notified = false
        model.onActivationKeyChange = { notified = true }
        model.setActivationKey(.rightCommand)
        XCTAssertTrue(notified)
        XCTAssertEqual(defaults.string(forKey: "activationKey"), "rightCommand")
        XCTAssertEqual(AppModel().activationKey, .rightCommand)
    }
}
