import XCTest
@testable import Mamachi

/// Behavior of the collapsed pill's level ring buffer: clamping, ordering,
/// resampling, decay smoothing, and reset.
@MainActor
final class AudioLevelHistoryTests: XCTestCase {
    func testEmptyHistoryYieldsSilentBars() {
        let history = AudioLevelHistory()
        let bars = history.bars(24)
        XCTAssertEqual(bars.count, 24)
        XCTAssertTrue(bars.allSatisfy { $0 == 0 })
    }

    func testZeroBarCountYieldsEmptyArray() {
        let history = AudioLevelHistory()
        history.append(0.5)
        XCTAssertTrue(history.bars(0).isEmpty)
    }

    func testAppendClampsToUnitRange() {
        let history = AudioLevelHistory(capacity: 4)
        history.append(3.0)
        history.append(-1.0)
        let bars = history.bars(4)
        XCTAssertEqual(bars.max(), 1.0)
        XCTAssertTrue(bars.allSatisfy { $0 >= 0 && $0 <= 1 })
    }

    func testMostRecentSampleLandsInLastBar() {
        let history = AudioLevelHistory(capacity: 8)
        history.append(0.9)
        let bars = history.bars(8)
        XCTAssertEqual(bars[7], 0.9, accuracy: 0.0001)
        XCTAssertEqual(bars[6], 0, accuracy: 0.0001)
    }

    func testOldestSampleDropsAfterWraparound() {
        let history = AudioLevelHistory(capacity: 4)
        history.append(1.0)
        for _ in 0..<4 { history.append(0.2) }
        // The 1.0 was overwritten; only decayed 0.2 remains.
        XCTAssertEqual(history.bars(4).max() ?? 0, 0.2, accuracy: 0.0001)
    }

    func testResamplingKeepsWindowPeak() {
        let history = AudioLevelHistory(capacity: 8)
        for level in [0.1, 0.8, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3] {
            history.append(level)
        }
        let bars = history.bars(4)
        XCTAssertEqual(bars.count, 4)
        XCTAssertEqual(bars[0], 0.8, accuracy: 0.0001)
        XCTAssertEqual(bars[3], 0.3, accuracy: 0.0001)
    }

    func testLoudBarDecaysGentlyIntoFollowingBars() {
        let history = AudioLevelHistory(capacity: 8)
        history.append(1.0)
        for _ in 0..<3 { history.append(0.0) }
        let bars = history.bars(8)
        // Samples sit at indices 4...7: [1, 0, 0, 0] before smoothing.
        XCTAssertEqual(bars[4], 1.0, accuracy: 0.0001)
        XCTAssertGreaterThan(bars[5], 0)
        XCTAssertLessThan(bars[5], bars[4])
        XCTAssertGreaterThan(bars[6], 0)
        XCTAssertLessThan(bars[6], bars[5])
    }

    func testClearSilencesEverything() {
        let history = AudioLevelHistory(capacity: 8)
        for _ in 0..<8 { history.append(1.0) }
        history.clear()
        XCTAssertTrue(history.bars(8).allSatisfy { $0 == 0 })
    }
}
