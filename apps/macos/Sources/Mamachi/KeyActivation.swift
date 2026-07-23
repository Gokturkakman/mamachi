import AppKit
import Foundation

/// User-selectable bare-modifier wake gesture. Bare modifiers ride on
/// `flagsChanged` events, which keep flowing under terminal Secure Keyboard
/// Entry where combo hotkeys like `⌥Space` are swallowed.
enum ActivationKey: String, CaseIterable, Identifiable {
    case fn
    case rightCommand
    case rightOption
    case off

    var id: String { rawValue }

    var label: String {
        switch self {
        case .fn: "Fn / Globe"
        case .rightCommand: "Right Command"
        case .rightOption: "Right Option"
        case .off: "Off"
        }
    }

    /// Virtual key code carried by the modifier's own `flagsChanged` events.
    /// Filtering on it distinguishes the physical Fn key from the synthetic
    /// `.function` flag arrow/page keys set on their `keyDown` events.
    var keyCode: UInt16? {
        switch self {
        case .fn: 63 // kVK_Function
        case .rightCommand: 54 // kVK_RightCommand
        case .rightOption: 61 // kVK_RightOption
        case .off: nil
        }
    }

    var flag: NSEvent.ModifierFlags? {
        switch self {
        case .fn: .function
        case .rightCommand: .command
        case .rightOption: .option
        case .off: nil
        }
    }
}

/// Gesture verdicts the recognizer emits. The consumer maps them onto
/// engagement transitions; the machine itself never touches audio or IPC.
enum ActivationVerdict: Equatable {
    /// Double-tap while the microphone sleeps: enter hands-free mode.
    case engageHandsFree
    /// Key held past the hold threshold while asleep: push-to-talk begins.
    case beginPushToTalk
    /// Push-to-talk key released: stop listening.
    case endPushToTalk
    /// Clean press+release while engaged: barge-in if speaking, else sleep.
    case tapWhileEngaged
}

/// Pure, clock-injected recognizer for tap / double-tap / hold gestures on a
/// bare modifier key. All timestamps share one monotonic clock (the caller
/// feeds `NSEvent.timestamp`, which is system uptime).
///
/// Disambiguation rules:
/// - Asleep: a lone tap does nothing, two taps within `doubleTapWindow`
///   engage hands-free (acted on the second key-DOWN for snappiness), a hold
///   past `holdThreshold` begins push-to-talk without waiting for release.
/// - Engaged: stopping is unambiguous, so the first clean release acts
///   immediately — no double-tap latency on the way out.
/// - Any other key pressed while our key is down marks the press as a combo
///   (Fn+arrow, media keys) and never fires.
final class ActivationGestureMachine {
    struct Tuning {
        var doubleTapWindow: TimeInterval = 0.35
        var holdThreshold: TimeInterval = 0.25

        init() {}
    }

    private enum Phase: Equatable {
        case idle
        /// Key is down; no verdict yet. `engagedAtPress` freezes which branch
        /// the press belongs to even if engagement changes underneath it.
        case firstDown(at: TimeInterval, poisoned: Bool, engagedAtPress: Bool)
        /// One clean tap seen while asleep; waiting for a second.
        case tapPending(expiresAt: TimeInterval)
        /// Hold recognized; listening until release.
        case pushToTalk
        /// Press already produced a verdict; swallow its release.
        case consumedDown
    }

    private let tuning: Tuning
    private let isEngaged: () -> Bool
    private var phase: Phase = .idle

    /// Absolute uptime at which `deadlineElapsed(at:)` should be called if no
    /// event arrives first. The monitor mirrors this into a timer.
    private(set) var pendingDeadline: TimeInterval?

    init(tuning: Tuning = Tuning(), isEngaged: @escaping () -> Bool) {
        self.tuning = tuning
        self.isEngaged = isEngaged
    }

    func keyDown(at now: TimeInterval) -> ActivationVerdict? {
        switch phase {
        case .idle:
            if isEngaged() {
                phase = .firstDown(at: now, poisoned: false, engagedAtPress: true)
                pendingDeadline = nil
            } else {
                phase = .firstDown(at: now, poisoned: false, engagedAtPress: false)
                pendingDeadline = now + tuning.holdThreshold
            }
            return nil
        case .tapPending(let expiresAt):
            pendingDeadline = nil
            guard now <= expiresAt, !isEngaged() else {
                // Window expired between timer grain, or engagement flipped
                // (e.g. a voice command engaged us): restart as a fresh press.
                phase = .idle
                return keyDown(at: now)
            }
            // Act on the second key-DOWN, not its release: shaves the last
            // ~100 ms off perceived wake latency.
            phase = .consumedDown
            return .engageHandsFree
        case .firstDown, .pushToTalk, .consumedDown:
            // Duplicate down without an up (event loss); keep current phase.
            return nil
        }
    }

    func keyUp(at now: TimeInterval) -> ActivationVerdict? {
        switch phase {
        case .firstDown(let pressedAt, let poisoned, let engagedAtPress):
            phase = .idle
            pendingDeadline = nil
            guard !poisoned else { return nil }
            if engagedAtPress {
                // Any clean release stops: matches both "tap again to close"
                // and the muscle memory of releasing a push-to-talk hold.
                return .tapWhileEngaged
            }
            // Clean short tap while asleep: arm the double-tap window.
            phase = .tapPending(expiresAt: now + tuning.doubleTapWindow)
            pendingDeadline = now + tuning.doubleTapWindow
            _ = pressedAt
            return nil
        case .pushToTalk:
            phase = .idle
            pendingDeadline = nil
            return .endPushToTalk
        case .consumedDown:
            phase = .idle
            pendingDeadline = nil
            return nil
        case .idle, .tapPending:
            return nil
        }
    }

    /// Any unrelated key press. Poisons an in-flight press (it is a combo,
    /// not a gesture) and cancels a pending double-tap (the user is typing).
    /// Push-to-talk deliberately survives: people hit keys while talking.
    func otherKeyDown(at now: TimeInterval) {
        switch phase {
        case .firstDown(let pressedAt, _, let engagedAtPress):
            phase = .firstDown(at: pressedAt, poisoned: true, engagedAtPress: engagedAtPress)
            pendingDeadline = nil
        case .tapPending:
            phase = .idle
            pendingDeadline = nil
        case .idle, .pushToTalk, .consumedDown:
            break
        }
        _ = now
    }

    func deadlineElapsed(at now: TimeInterval) -> ActivationVerdict? {
        switch phase {
        case .firstDown(let pressedAt, let poisoned, let engagedAtPress):
            guard
                !poisoned,
                !engagedAtPress,
                now - pressedAt >= tuning.holdThreshold
            else { return nil }
            phase = .pushToTalk
            pendingDeadline = nil
            return .beginPushToTalk
        case .tapPending(let expiresAt):
            guard now >= expiresAt else { return nil }
            // Lone tap while asleep: intentionally a no-op so stray Fn
            // presses (emoji habit, backlight) never wake the microphone.
            phase = .idle
            pendingDeadline = nil
            return nil
        case .idle, .pushToTalk, .consumedDown:
            return nil
        }
    }
}

/// Global + local `NSEvent` monitor pair that feeds the gesture machine.
///
/// Monitors are observe-only: key content is never inspected — unrelated
/// `keyDown`/`systemDefined` events are used solely as "this press is a
/// combo" poison signals. Requires Accessibility trust; without it macOS
/// silently delivers nothing, so callers must gate on `hasAccessibilityTrust`.
@MainActor
final class KeyActivationMonitor {
    static var hasAccessibilityTrust: Bool { AXIsProcessTrusted() }

    private let key: ActivationKey
    private let machine: ActivationGestureMachine
    private let onVerdict: (ActivationVerdict) -> Void
    private var monitors: [Any] = []
    private var deadlineTimer: Timer?
    private var modifierIsDown = false

    init?(
        key: ActivationKey,
        isEngaged: @escaping () -> Bool,
        onVerdict: @escaping (ActivationVerdict) -> Void
    ) {
        guard key != .off, key.keyCode != nil, Self.hasAccessibilityTrust else { return nil }
        self.key = key
        self.machine = ActivationGestureMachine(isEngaged: isEngaged)
        self.onVerdict = onVerdict

        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .systemDefined]
        // Global monitors exclude our own app; the local monitor covers
        // presses while the overlay composer or settings have focus.
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.consume(event)
        }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.consume(event)
            return event
        }) {
            monitors.append(local)
        }
        guard !monitors.isEmpty else { return nil }
    }

    deinit {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        deadlineTimer?.invalidate()
    }

    private func consume(_ event: NSEvent) {
        switch event.type {
        case .flagsChanged:
            guard event.keyCode == key.keyCode, let flag = key.flag else { return }
            let down = event.modifierFlags.contains(flag)
            guard down != modifierIsDown else { return }
            modifierIsDown = down
            emit(down ? machine.keyDown(at: event.timestamp) : machine.keyUp(at: event.timestamp))
        case .keyDown, .systemDefined:
            // systemDefined covers media/brightness keys, which never produce
            // keyDown but do mean "Fn was a combo modifier just now".
            machine.otherKeyDown(at: event.timestamp)
            syncDeadline()
        default:
            break
        }
    }

    private func emit(_ verdict: ActivationVerdict?) {
        syncDeadline()
        if let verdict { onVerdict(verdict) }
    }

    private func syncDeadline() {
        deadlineTimer?.invalidate()
        deadlineTimer = nil
        guard let deadline = machine.pendingDeadline else { return }
        let delay = max(0, deadline - ProcessInfo.processInfo.systemUptime)
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.emit(self.machine.deadlineElapsed(at: deadline))
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        deadlineTimer = timer
    }
}
