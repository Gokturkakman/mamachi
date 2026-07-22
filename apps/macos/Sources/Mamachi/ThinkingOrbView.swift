import SwiftUI

// Native SwiftUI port of the dotted 2D-canvas language from
// Jakub Antalik's MIT-licensed thinking-orbs component.
struct ThinkingOrbView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: VoiceConnectionState
    let microphoneLevel: Double
    var size: CGFloat

    @State private var renderedMode: OrbMode
    @State private var previousMode: OrbMode?
    @State private var transitionStartedAt = Date.distantPast

    init(state: VoiceConnectionState, microphoneLevel: Double, size: CGFloat = 88) {
        self.state = state
        self.microphoneLevel = microphoneLevel
        self.size = size
        _renderedMode = State(initialValue: Self.mode(for: state))
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || (!isAnimated && previousMode == nil))) { timeline in
            Canvas(rendersAsynchronously: true) { context, canvasSize in
                let clock = reduceMotion ? 0.7 : timeline.date.timeIntervalSinceReferenceDate
                let side = min(canvasSize.width, canvasSize.height)
                let transition = reduceMotion
                    ? 1
                    : min(1, max(0, timeline.date.timeIntervalSince(transitionStartedAt) / 0.38))
                let opacity = state == .disconnected ? 0.38 : 1

                if let previousMode, transition < 1 {
                    OrbRenderer.paint(
                        dots(for: previousMode, size: side, clock: clock),
                        into: &context,
                        dark: colorScheme == .dark,
                        opacity: opacity * (1 - transition)
                    )
                }
                OrbRenderer.paint(
                    dots(for: renderedMode, size: side, clock: clock),
                    into: &context,
                    dark: colorScheme == .dark,
                    opacity: opacity * (previousMode == nil ? 1 : transition)
                )
            }
        }
        .frame(width: size, height: size)
        .onChange(of: Self.mode(for: state)) { _, nextMode in
            guard nextMode != renderedMode else { return }
            previousMode = renderedMode
            renderedMode = nextMode
            transitionStartedAt = Date()
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(400))
                if renderedMode == nextMode { previousMode = nil }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private func dots(for mode: OrbMode, size: Double, clock: Double) -> [OrbDot] {
        switch mode {
        case .solving:
            OrbRenderer.solving(size: size, time: clock * 2.2)
        case .listening:
            OrbRenderer.wave(size: size, time: clock * 4.388, level: microphoneLevel)
        case .thinking:
            OrbRenderer.globe(size: size, time: clock * 2.015)
        case .speaking:
            OrbRenderer.ribbon(size: size, time: clock * 2.34)
        case .idle:
            OrbRenderer.wave(size: size, time: 0.7, level: 0.05)
        }
    }

    private static func mode(for state: VoiceConnectionState) -> OrbMode {
        switch state {
        case .listening: .listening
        case .connecting, .connected: .solving
        case .thinking: .thinking
        case .speaking: .speaking
        case .disconnected, .error: .idle
        }
    }

    private var isAnimated: Bool {
        switch state {
        case .connecting, .connected, .listening, .thinking, .speaking: true
        case .disconnected, .error: false
        }
    }

    private var accessibilityLabel: String {
        switch state {
        case .listening: "Mamachi is listening"
        case .thinking: "Mamachi is thinking"
        case .speaking: "Mamachi is speaking"
        case .connecting: "Mamachi is connecting"
        case .connected: "Mamachi is ready"
        case .disconnected: "Mamachi voice is offline"
        case .error: "Mamachi needs attention"
        }
    }
}

private enum OrbMode {
    case solving
    case idle
    case listening
    case thinking
    case speaking
}

private struct OrbMove {
    let axis: Int
    let lowerBound: Double
    let upperBound: Double
    let angle: Double
}

private struct OrbDot {
    let x: Double
    let y: Double
    let z: Double
    let radius: Double
    let white: Double
    var alpha = 1.0
}

private enum OrbRenderer {
    private static let solvingMoves = makeMoves(count: 10)

    static func solving(size: Double, time: Double) -> [OrbDot] {
        let center = size / 2
        let sphereRadius = (size / 2) * 0.82
        let radiusMultiplier = radiusScale(size)
        let cycle = solveCycle(time: time, count: solvingMoves.count, slotDuration: 0.42, rest: 1.2)
        let latitudeRings = 11
        let longitudeDensity = 29
        var dots: [OrbDot] = []
        dots.reserveCapacity(220)

        for ring in 0...latitudeRings {
            let latitude = -.pi / 2 + (Double(ring) / Double(latitudeRings)) * .pi
            let cosine = cos(latitude)
            let sine = sin(latitude)
            let longitudeCount = max(1, Int((abs(cosine) * Double(longitudeDensity)).rounded()))
            for longitudeIndex in 0..<longitudeCount {
                let longitude = (Double(longitudeIndex) / Double(longitudeCount)) * 2 * .pi
                let moved = applyMoves(
                    x: cosine * cos(longitude),
                    y: sine,
                    z: cosine * sin(longitude),
                    amounts: cycle.amounts,
                    activeMove: cycle.active
                )
                let projected = project(
                    x: moved.x,
                    y: moved.y,
                    z: moved.z,
                    yaw: time * 0.55,
                    tilt: 0.35 + 0.1 * sin(time * 0.9),
                    centerX: center,
                    centerY: center,
                    scale: sphereRadius
                )
                let depth = (projected.z + 1) / 2
                dots.append(
                    OrbDot(
                        x: projected.x,
                        y: projected.y,
                        z: projected.z,
                        radius: (0.6 + 1.7 * depth + (moved.isActive ? 0.3 : 0)) * radiusMultiplier,
                        white: 0.62 - 0.54 * depth - (moved.isActive ? 0.14 : 0)
                    )
                )
            }
        }
        return dots
    }

    static func wave(size: Double, time: Double, level: Double) -> [OrbDot] {
        let center = size / 2
        let sphereRadius = (size / 2) * 0.874
        let radiusMultiplier = radiusScale(size)
        let levelBoost = 0.82 + min(1, max(0, level)) * 0.7
        let rings = 9
        let longitudeDensity = 26
        var dots: [OrbDot] = []
        dots.reserveCapacity(190)

        for ring in 0...rings {
            let latitude = -.pi / 2 + (Double(ring) / Double(rings)) * .pi
            let cosine = cos(latitude)
            let sine = sin(latitude)
            let wave = 0.62 * sin(time * 2.1 - Double(ring) * 0.52)
                + 0.38 * sin(time * 1.27 + Double(ring) * 0.83)
            let radius = sphereRadius * (0.88 + 0.105 * wave * levelBoost)
            let longitudeCount = max(1, Int((abs(cosine) * Double(longitudeDensity)).rounded()))
            for longitudeIndex in 0..<longitudeCount {
                let longitude = (Double(longitudeIndex) / Double(longitudeCount)) * 2 * .pi
                let projected = project(
                    x: cosine * cos(longitude) * radius,
                    y: sine * radius,
                    z: cosine * sin(longitude) * radius,
                    yaw: time * 0.18,
                    tilt: 0.38,
                    centerX: center,
                    centerY: center,
                    scale: 1
                )
                let depth = (projected.z / sphereRadius + 1) / 2
                let crest = max(0, wave)
                dots.append(
                    OrbDot(
                        x: projected.x,
                        y: projected.y,
                        z: projected.z,
                        radius: (0.6 + 1.7 * depth) * (1 + 0.4 * crest) * radiusMultiplier,
                        white: 0.66 - 0.56 * depth - 0.1 * crest
                    )
                )
            }
        }
        return dots
    }

    static func globe(size: Double, time: Double) -> [OrbDot] {
        let spin = 0.5
        let center = size / 2
        let sphereRadius = (size / 2) * 0.82
        let tilt = 0.4 + 0.06 * sin(time * 0.35)
        let scan = time * (spin + (1.7 - spin) * 4.08)
        let radiusMultiplier = radiusScale(size)
        let latitudeRings = 11
        let longitudeDensity = 29
        var dots: [OrbDot] = []
        dots.reserveCapacity(220)

        for ring in 0...latitudeRings {
            let latitude = -.pi / 2 + (Double(ring) / Double(latitudeRings)) * .pi
            let cosine = cos(latitude)
            let sine = sin(latitude)
            let longitudeCount = max(1, Int((abs(cosine) * Double(longitudeDensity)).rounded()))
            for longitudeIndex in 0..<longitudeCount {
                let longitude = (Double(longitudeIndex) / Double(longitudeCount)) * 2 * .pi
                let projected = project(
                    x: cosine * cos(longitude),
                    y: sine,
                    z: cosine * sin(longitude),
                    yaw: time * spin,
                    tilt: tilt,
                    centerX: center,
                    centerY: center,
                    scale: sphereRadius
                )
                let depth = (projected.z + 1) / 2
                let distance = angleDelta(longitude + time * spin, scan)
                let boost = exp(-(distance * distance) / 0.18) * max(0, projected.z)
                dots.append(
                    OrbDot(
                        x: projected.x,
                        y: projected.y,
                        z: projected.z,
                        radius: (0.69 + 1.955 * depth + 1.15 * boost) * radiusMultiplier,
                        white: 0.62 - 0.54 * depth,
                        alpha: 0.45 + 0.55 * min(1, boost)
                    )
                )
            }
        }
        return dots
    }

    static func ribbon(size: Double, time: Double) -> [OrbDot] {
        let center = size / 2
        let sphereRadius = (size / 2) * 0.78
        let radiusMultiplier = radiusScale(size)
        var dots: [OrbDot] = []
        dots.reserveCapacity(600)

        let ghostCount = 38
        for index in 0..<ghostCount {
            let direction = fibonacciDirection(index: index, count: ghostCount)
            let projected = project(
                x: direction.x * sphereRadius,
                y: direction.y * sphereRadius,
                z: direction.z * sphereRadius,
                yaw: 0,
                tilt: 0.3,
                centerX: center,
                centerY: center,
                scale: 1
            )
            let depth = (projected.z / sphereRadius + 1) / 2
            dots.append(
                OrbDot(
                    x: projected.x,
                    y: projected.y,
                    z: projected.z,
                    radius: 0.8 * radiusMultiplier,
                    white: 0.78,
                    alpha: 0.1 + 0.22 * depth
                )
            )
        }

        let tiltAngle = 0.55
        let unitX = (x: 1.0, y: 0.0, z: 0.0)
        let unitY = (x: 0.0, y: cos(tiltAngle), z: sin(tiltAngle))
        let normal = (x: 0.0, y: -sin(tiltAngle), z: cos(tiltAngle))
        let lanes = 12
        let segments = 44

        for lane in 0..<lanes {
            let offset = (Double(lane) - Double(lanes - 1) / 2) * 0.075
            let edge = abs(Double(lane) - Double(lanes - 1) / 2) / max(1, Double(lanes - 1) / 2)
            for segment in 0..<segments {
                let angle = (Double(segment) / Double(segments)) * 2 * .pi
                let wobble = 0.16 * sin(angle * 3 - time * 1.7 + Double(lane) * 0.22)
                    + 0.07 * sin(angle * 5 + time * 1.1)
                let displacement = offset + wobble
                let x = unitX.x * cos(angle) + unitY.x * sin(angle) + normal.x * displacement
                let y = unitX.y * cos(angle) + unitY.y * sin(angle) + normal.y * displacement
                let z = unitX.z * cos(angle) + unitY.z * sin(angle) + normal.z * displacement
                let length = sqrt(x * x + y * y + z * z)
                let projected = project(
                    x: (x / length) * sphereRadius,
                    y: (y / length) * sphereRadius,
                    z: (z / length) * sphereRadius,
                    yaw: 0,
                    tilt: 0.3,
                    centerX: center,
                    centerY: center,
                    scale: 1
                )
                let depth = (projected.z / sphereRadius + 1) / 2
                dots.append(
                    OrbDot(
                        x: projected.x,
                        y: projected.y,
                        z: projected.z,
                        radius: (0.935 + 1.445 * depth) * (1 - 0.25 * edge) * radiusMultiplier,
                        white: 0.52 - 0.44 * depth + 0.18 * edge,
                        alpha: 0.4 + 0.6 * depth
                    )
                )
            }
        }
        return dots
    }

    static func paint(_ unsortedDots: [OrbDot], into context: inout GraphicsContext, dark: Bool, opacity: Double) {
        for dot in unsortedDots.sorted(by: { $0.z < $1.z }) where dot.alpha >= 0.02 {
            let white = min(1, max(0, dot.white))
            let gray = dark ? 1 - white : white
            let radius = max(0.3, dot.radius)
            let rect = CGRect(x: dot.x - radius, y: dot.y - radius, width: radius * 2, height: radius * 2)
            context.fill(
                Path(ellipseIn: rect),
                with: .color(Color(white: gray).opacity(dot.alpha * opacity))
            )
        }
    }

    private static func project(
        x: Double,
        y: Double,
        z: Double,
        yaw: Double,
        tilt: Double,
        centerX: Double,
        centerY: Double,
        scale: Double
    ) -> (x: Double, y: Double, z: Double) {
        let sineTilt = sin(tilt)
        let cosineTilt = cos(tilt)
        let sineYaw = sin(yaw)
        let cosineYaw = cos(yaw)
        let rotatedX = x * cosineYaw + z * sineYaw
        let rotatedZ = -x * sineYaw + z * cosineYaw
        let rotatedY = y * cosineTilt - rotatedZ * sineTilt
        let depth = y * sineTilt + rotatedZ * cosineTilt
        return (centerX + rotatedX * scale, centerY - rotatedY * scale, depth)
    }

    private static func fibonacciDirection(index: Int, count: Int) -> (x: Double, y: Double, z: Double) {
        let golden = Double.pi * (3 - sqrt(5))
        let y = 1 - (2 * (Double(index) + 0.5)) / Double(count)
        let radial = sqrt(1 - y * y)
        let angle = Double(index) * golden
        return (radial * cos(angle), y, radial * sin(angle))
    }

    private static func angleDelta(_ first: Double, _ second: Double) -> Double {
        atan2(sin(first - second), cos(first - second))
    }

    private static func solveCycle(
        time: Double,
        count: Int,
        slotDuration: Double,
        rest: Double
    ) -> (amounts: [Double], active: Int) {
        let duration = 2 * Double(count) * slotDuration + rest
        let cycleTime = time.truncatingRemainder(dividingBy: duration)
        var amounts = Array(repeating: 0.0, count: count)
        var active = -1
        guard cycleTime < 2 * Double(count) * slotDuration else { return (amounts, active) }
        let slot = Int(floor(cycleTime / slotDuration))
        let progress = (cycleTime - Double(slot) * slotDuration) / slotDuration
        let clamped = min(1, progress / 0.7)
        let eased = 1 - pow(1 - clamped, 3)
        if slot < count {
            for index in 0..<slot { amounts[index] = 1 }
            amounts[slot] = eased
            active = slot
        } else {
            let reverseIndex = 2 * count - 1 - slot
            for index in 0..<reverseIndex { amounts[index] = 1 }
            amounts[reverseIndex] = 1 - eased
            active = reverseIndex
        }
        return (amounts, active)
    }

    private static func makeMoves(count: Int) -> [OrbMove] {
        (0..<count).map { index in
            let axis = min(2, Int(floor(hash(index, salt: 2.3) * 3)))
            let lowerBound = -1 + 0.5 * Double(min(3, Int(floor(hash(index, salt: 5.9) * 4))))
            let direction = hash(index, salt: 7.7) < 0.5 ? 1.0 : -1.0
            return OrbMove(
                axis: axis,
                lowerBound: lowerBound,
                upperBound: lowerBound + 0.5,
                angle: direction * .pi / 2
            )
        }
    }

    private static func applyMoves(
        x initialX: Double,
        y initialY: Double,
        z initialZ: Double,
        amounts: [Double],
        activeMove: Int
    ) -> (x: Double, y: Double, z: Double, isActive: Bool) {
        var x = initialX
        var y = initialY
        var z = initialZ
        var isActive = false
        for index in solvingMoves.indices where amounts[index] > 0 {
            let move = solvingMoves[index]
            let coordinate = move.axis == 0 ? x : move.axis == 1 ? y : z
            guard coordinate >= move.lowerBound, coordinate < move.upperBound else { continue }
            if index == activeMove { isActive = true }
            let angle = move.angle * amounts[index]
            let cosine = cos(angle)
            let sine = sin(angle)
            if move.axis == 0 {
                let nextY = y * cosine - z * sine
                z = y * sine + z * cosine
                y = nextY
            } else if move.axis == 1 {
                let nextX = x * cosine + z * sine
                z = -x * sine + z * cosine
                x = nextX
            } else {
                let nextX = x * cosine - y * sine
                y = x * sine + y * cosine
                x = nextX
            }
        }
        return (x, y, z, isActive)
    }

    private static func hash(_ index: Int, salt: Double) -> Double {
        let value = sin(Double(index) * 12.9898 + salt * 78.233) * 43_758.5453
        return value - floor(value)
    }

    private static func radiusScale(_ size: Double) -> Double {
        pow(size / 300, 0.6)
    }
}
