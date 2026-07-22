import SwiftUI

/// Central design language: restrained liquid-glass surfaces with one
/// signature ice-cyan → violet gradient reserved for brand moments.
enum Theme {
    /// Ice cyan — leading brand tone.
    static let accentA = Color(red: 0.40, green: 0.76, blue: 1.00)
    /// Soft violet — trailing brand tone.
    static let accentB = Color(red: 0.60, green: 0.48, blue: 1.00)

    /// Signature gradient. Use sparingly: send button, assistant marker, live accents.
    static var brand: LinearGradient {
        LinearGradient(colors: [accentA, accentB], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// Specular hairline for glass edges: bright at the top, faint violet at the bottom.
    static var specularEdge: LinearGradient {
        LinearGradient(
            stops: [
                .init(color: .white.opacity(0.38), location: 0.0),
                .init(color: .white.opacity(0.10), location: 0.28),
                .init(color: .white.opacity(0.06), location: 0.72),
                .init(color: accentB.opacity(0.22), location: 1.0),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    /// Subtle vertical wash layered over panel material for depth.
    static var panelWash: LinearGradient {
        LinearGradient(
            stops: [
                .init(color: .white.opacity(0.06), location: 0.0),
                .init(color: .clear, location: 0.38),
                .init(color: accentB.opacity(0.05), location: 1.0),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    /// Task-state color. System semantics for terminal states, brand cyan for live work.
    static func statusColor(_ state: String) -> Color {
        switch state {
        case "completed": .green
        case "failed", "cancelled": .red
        case "paused", "pause_requested", "awaiting_user": .orange
        default: accentA
        }
    }
}

/// Inset glass card used for sections inside the overlay panel.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = 14

    func body(content: Content) -> some View {
        content
            .background(
                Color.primary.opacity(0.04),
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
            }
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = 14) -> some View {
        modifier(GlassCard(cornerRadius: cornerRadius))
    }
}

/// Tracked, small-caps section heading.
struct SectionLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold, design: .rounded))
            .tracking(1.1)
            .foregroundStyle(.secondary)
    }
}

/// Capsule task-state chip with a glowing status dot that breathes while work is live.
struct StatusChip: View {
    let state: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false

    private var color: Color { Theme.statusColor(state) }
    private var isLive: Bool { ["running", "pause_requested", "dispatching"].contains(state) }

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 5, height: 5)
                .shadow(color: color.opacity(0.9), radius: 2.5)
                .opacity(isLive && dimmed ? 0.3 : 1)
            Text(state.replacingOccurrences(of: "_", with: " ").uppercased())
                .font(.system(size: 8.5, weight: .bold, design: .rounded))
                .tracking(0.9)
                .foregroundStyle(color)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3.5)
        .background(color.opacity(0.11), in: Capsule())
        .overlay {
            Capsule().strokeBorder(color.opacity(0.22), lineWidth: 1)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.05).repeatForever(autoreverses: true)) {
                dimmed = true
            }
        }
    }
}

/// Small capsule action button with a hover state.
struct PillButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 10, weight: .semibold))
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Color.primary.opacity(hovering ? 0.11 : 0.06), in: Capsule())
                .overlay {
                    Capsule().strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// Circular icon button that lights up on hover.
struct GlassIconButton: View {
    let systemImage: String
    var size: CGFloat = 26
    var iconSize: CGFloat = 11
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: iconSize, weight: .semibold))
                .foregroundStyle(hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .frame(width: size, height: size)
                .background(Color.primary.opacity(hovering ? 0.08 : 0), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help(help)
    }
}
