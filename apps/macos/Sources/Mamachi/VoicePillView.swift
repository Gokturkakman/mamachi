import SwiftUI

/// Fixed-size ring buffer of recent normalized audio levels (0...1).
///
/// Deliberately not `@Published`: samples arrive at roughly 20-25 Hz and the
/// pill's `TimelineView` reads the buffer once per frame instead of
/// invalidating SwiftUI on every sample.
@MainActor
final class AudioLevelHistory {
    private let capacity: Int
    private var samples: [Double]
    private var head = 0

    init(capacity: Int = 64) {
        self.capacity = max(1, capacity)
        samples = [Double](repeating: 0, count: self.capacity)
    }

    func append(_ level: Double) {
        samples[head] = min(1, max(0, level))
        head = (head + 1) % capacity
    }

    func clear() {
        for index in samples.indices { samples[index] = 0 }
        head = 0
    }

    /// Resamples the buffer into `count` bars, oldest first and most recent
    /// last, keeping the peak of each window and letting loud bars decay
    /// gently into the quieter bars that follow them.
    func bars(_ count: Int) -> [Double] {
        guard count > 0 else { return [] }
        var resampled = [Double](repeating: 0, count: count)
        let step = Double(capacity) / Double(count)
        for bar in 0..<count {
            let start = Int(Double(bar) * step)
            let end = min(capacity, max(start + 1, Int(Double(bar + 1) * step)))
            var peak = 0.0
            for offset in start..<end {
                peak = max(peak, samples[(head + offset) % capacity])
            }
            resampled[bar] = peak
        }
        var carried = 0.0
        for bar in 0..<count {
            carried = max(resampled[bar], carried * 0.72)
            resampled[bar] = carried
        }
        return resampled
    }
}

/// What the collapsed pill is currently communicating.
enum VoicePillState: Equatable {
    case dormant(text: String)
    case connecting
    case listening
    case thinking
    case speaking
    case attention(text: String)

    /// Short status phrase for container-level accessibility labels.
    var accessibilityText: String {
        switch self {
        case .dormant(let text): text
        case .connecting: "Connecting"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .attention(let text): text
        }
    }
}

/// Collapsed-pill content: dormant/attention keep the classic text row while
/// live voice states render a Wispr-style center-out waveform driven by the
/// microphone and playback level histories.
struct VoicePillView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: VoicePillState
    let inputLevels: AudioLevelHistory
    let outputLevels: AudioLevelHistory

    private static let maxBars = 36
    private static let barWidth = 2.5
    private static let barGap = 2.0

    var body: some View {
        Group {
            switch state {
            case .dormant(let text):
                textRow(text, tint: .secondary)
            case .attention(let text):
                textRow(text, tint: .orange)
            case .connecting, .listening, .thinking, .speaking:
                waveform
            }
        }
    }

    private func textRow(_ text: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Capsule()
                .fill(tint)
                .frame(width: 18, height: 3)

            Text(text)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(.primary)
                .lineLimit(1)

            Spacer(minLength: 2)

            Image(systemName: "chevron.up")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.tertiary)
        }
    }

    private var waveform: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
            // Levels and modulation are sampled here, on the main actor, so
            // the canvas closure only touches plain values.
            let clock = reduceMotion ? 0.7 : timeline.date.timeIntervalSinceReferenceDate
            let levels = waveformLevels(clock: clock)
            let opacity = waveformOpacity(clock: clock)
            let glow = waveformGlow
            let shadingColors = waveformColors
            Canvas(rendersAsynchronously: true) { context, size in
                Self.drawBars(
                    levels,
                    into: &context,
                    size: size,
                    colors: shadingColors,
                    opacity: opacity,
                    glow: glow
                )
            }
        }
    }

    private func waveformLevels(clock: Double) -> [Double] {
        switch state {
        case .listening:
            return inputLevels.bars(Self.maxBars)
        case .speaking:
            return outputLevels.bars(Self.maxBars)
        case .thinking:
            // Gentle traveling shimmer instead of live audio.
            return (0..<Self.maxBars).map { bar -> Double in
                let phase = clock * 2.6 - Double(bar) * 0.48
                let normalizedWave = (1.0 + sin(phase)) / 2.0
                return 0.10 + 0.12 * normalizedWave
            }
        case .connecting:
            return [Double](repeating: 0.04, count: Self.maxBars)
        case .dormant, .attention:
            return []
        }
    }

    private func waveformOpacity(clock: Double) -> Double {
        switch state {
        case .connecting:
            // Dim slow pulse while the realtime session comes up.
            return 0.35 + 0.07 * sin(clock * 1.7)
        case .thinking:
            return 0.625 + 0.075 * sin(clock * 2.6)
        case .listening, .speaking:
            return 1
        case .dormant, .attention:
            return 0
        }
    }

    private var waveformGlow: Double {
        switch state {
        case .listening: 0.45
        case .speaking: 0.35
        case .thinking, .connecting, .dormant, .attention: 0
        }
    }

    private var waveformColors: [Color] {
        switch state {
        case .listening: [Theme.accentA, Theme.accentB]
        case .speaking: [Theme.accentB, Theme.accentB.opacity(0.75)]
        case .thinking: [Theme.accentA.opacity(0.8), Theme.accentB.opacity(0.8)]
        case .connecting: [Color.secondary, Color.secondary]
        case .dormant, .attention: []
        }
    }

    private static func drawBars(
        _ levels: [Double],
        into context: inout GraphicsContext,
        size: CGSize,
        colors: [Color],
        opacity: Double,
        glow: Double
    ) {
        guard !levels.isEmpty, !colors.isEmpty, size.width > 0, size.height > 0 else { return }
        let pitch = barWidth + barGap
        let fitting = max(1, Int((size.width - barGap + pitch - 1) / pitch))
        let shown = Array(levels.suffix(fitting))
        let rowWidth = Double(shown.count) * pitch - barGap
        let originX = (size.width - rowWidth) / 2
        let minHeight = barWidth
        let maxHeight = max(minHeight, size.height - 6)
        let midY = size.height / 2

        var row = Path()
        for (index, level) in shown.enumerated() {
            let height = minHeight + level * (maxHeight - minHeight)
            let rect = CGRect(
                x: originX + Double(index) * pitch,
                y: midY - height / 2,
                width: barWidth,
                height: height
            )
            row.addRoundedRect(in: rect, cornerSize: CGSize(width: barWidth / 2, height: barWidth / 2))
        }

        let shading = GraphicsContext.Shading.linearGradient(
            Gradient(colors: colors),
            startPoint: CGPoint(x: originX, y: midY),
            endPoint: CGPoint(x: originX + rowWidth, y: midY)
        )
        context.opacity = opacity
        if glow > 0 {
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 2.5))
                layer.opacity = glow
                layer.fill(row, with: shading)
            }
        }
        context.fill(row, with: shading)
    }

}
