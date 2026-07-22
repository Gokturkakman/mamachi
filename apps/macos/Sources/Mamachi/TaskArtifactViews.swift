import AppKit
import SwiftUI

/// Builds `vscode://file/...` deep links for files, ranges, and the workspace.
enum VSCodeLink {
    static func url(workspace: String, path: String? = nil, line: Int? = nil) -> URL? {
        var absolute = workspace
        if let path, !path.isEmpty {
            absolute = path.hasPrefix("/") ? path : workspace + "/" + path
        }
        guard var encoded = absolute.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            return nil
        }
        if let line, line > 0 { encoded += ":\(line)" }
        return URL(string: "vscode://file\(encoded)")
    }

    static func open(workspace: String, path: String? = nil, line: Int? = nil) {
        guard let url = url(workspace: workspace, path: path, line: line) else { return }
        NSWorkspace.shared.open(url)
    }
}

/// Capsule showing which repository the coder is grounded in.
/// Clicking opens the workspace in VS Code.
struct RepositoryChip: View {
    let workspace: String
    @State private var hovering = false

    private var name: String {
        let component = URL(filePath: workspace, directoryHint: .isDirectory).lastPathComponent
        return component.isEmpty ? workspace : component
    }

    var body: some View {
        Button {
            VSCodeLink.open(workspace: workspace)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(Theme.accentA)
                Text(name)
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 4.5)
            .background(.regularMaterial, in: Capsule())
            .overlay {
                Capsule().strokeBorder(
                    hovering ? Theme.accentA.opacity(0.45) : Color.primary.opacity(0.1),
                    lineWidth: 1
                )
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("Repository: \(workspace) — click to open in VS Code")
        .accessibilityLabel("Repository \(name)")
        .accessibilityHint("Opens the workspace in VS Code")
    }
}

/// Capsule summarizing what the coder is doing right now.
struct CodingStatusChip: View {
    let task: TaskViewState?
    var queueCount = 0

    private var color: Color {
        guard let task else { return .secondary }
        return Theme.statusColor(task.state)
    }

    private var label: String {
        guard let task else { return "Coder idle" }
        switch task.state {
        case "awaiting_user": return "Needs your input"
        case "running": return task.phase.map { "Coding · \($0)" } ?? "Coding"
        default: return "Coder \(task.state.replacingOccurrences(of: "_", with: " "))"
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 5, height: 5)
                .shadow(color: color.opacity(task == nil ? 0 : 0.9), radius: 2.5)
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(task == nil ? .secondary : .primary)
                .lineLimit(1)
            if queueCount > 0 {
                Text("+\(queueCount) queued")
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4.5)
        .background(Color.primary.opacity(0.05), in: Capsule())
        .overlay {
            Capsule().strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            queueCount > 0 ? "\(label), \(queueCount) tasks queued" : label
        )
    }
}

/// Removable attachment chip for a captured context item.
struct ContextChip: View {
    let context: CapturedContextViewState
    var onRemove: ((CapturedContextViewState) -> Void)?
    @State private var hovering = false

    private var icon: String {
        switch context.kind {
        case "screenshot", "screen": "camera.viewfinder"
        case "selection", "text": "text.quote"
        case "clipboard": "doc.on.clipboard"
        case "file": "doc"
        case "url", "link": "link"
        default: "paperclip"
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(Theme.accentB)
            Text(context.summary)
                .font(.system(size: 10))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 170, alignment: .leading)
            if let onRemove {
                Button {
                    onRemove(context)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                        .frame(width: 14, height: 14)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .help("Remove this captured context")
                .accessibilityLabel("Remove captured \(context.kind)")
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, onRemove == nil ? 8 : 4)
        .padding(.vertical, 4)
        .background(Theme.accentB.opacity(0.08), in: Capsule())
        .overlay {
            Capsule().strokeBorder(Theme.accentB.opacity(0.16), lineWidth: 1)
        }
        .onHover { hovering = $0 }
        .help(context.summary)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Captured \(context.kind): \(context.summary)")
    }
}

/// Collapsible drawer section with a count badge — the progressive-disclosure
/// building block for task facts.
struct DrawerDisclosure<Content: View>: View {
    let title: String
    let systemImage: String
    var count: Int?
    var tint: Color = .secondary
    @State private var expanded: Bool
    @ViewBuilder let content: () -> Content

    init(
        _ title: String,
        systemImage: String,
        count: Int? = nil,
        tint: Color = .secondary,
        initiallyExpanded: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.systemImage = systemImage
        self.count = count
        self.tint = tint
        _expanded = State(initialValue: initiallyExpanded)
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.smooth(duration: 0.24)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: systemImage)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(tint)
                        .frame(width: 14)
                    SectionLabel(title)
                    if let count, count > 0 {
                        Text("\(count)")
                            .font(.system(size: 8.5, weight: .bold, design: .rounded))
                            .foregroundStyle(tint)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(tint.opacity(0.13), in: Capsule())
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(count.map { "\(title), \($0) items" } ?? title)
            .accessibilityValue(expanded ? "expanded" : "collapsed")
            .accessibilityHint("Toggles the \(title.lowercased()) section")

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    content()
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 11)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .glassCard()
    }
}

/// Muted single-line hint for sections that have no facts yet.
struct DrawerEmptyHint: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(.tertiary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One changed file, deep-linkable into VS Code at its range.
struct ChangedFileRow: View {
    let file: ChangedFileViewState
    let workspace: String
    @State private var hovering = false

    private var kindIcon: (name: String, color: Color) {
        switch file.kind {
        case "added": ("plus.circle.fill", .green)
        case "deleted", "removed": ("minus.circle.fill", .red)
        case "renamed": ("arrow.right.circle.fill", .orange)
        default: ("pencil.circle.fill", Theme.accentA)
        }
    }

    private var fileName: String {
        URL(filePath: file.path).lastPathComponent
    }

    private var directory: String {
        let dir = URL(filePath: file.path).deletingLastPathComponent().path
        return dir == "." || dir == "/" ? "" : dir
    }

    private var rangeLabel: String? {
        guard let line = file.line else { return nil }
        if let end = file.endLine, end > line { return "L\(line)–\(end)" }
        return "L\(line)"
    }

    var body: some View {
        Button {
            VSCodeLink.open(workspace: workspace, path: file.path, line: file.line)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: kindIcon.name)
                    .font(.system(size: 10))
                    .foregroundStyle(kindIcon.color)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(fileName)
                            .font(.system(size: 10.5, weight: .medium))
                            .lineLimit(1)
                        if let rangeLabel {
                            Text(rangeLabel)
                                .font(.system(size: 8.5, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    if !directory.isEmpty {
                        Text(directory)
                            .font(.system(size: 8.5))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                Spacer()
                Image(systemName: "arrow.up.forward.square")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(hovering ? AnyShapeStyle(Theme.accentA) : AnyShapeStyle(.tertiary))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color.primary.opacity(hovering ? 0.06 : 0), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("Open \(file.path) in VS Code")
        .accessibilityLabel("\(file.kind.capitalized) file \(fileName)")
        .accessibilityHint("Opens in VS Code" + (rangeLabel.map { " at \($0)" } ?? ""))
    }
}

/// One piece of verification evidence: a test run, build, or manual check.
struct EvidenceRow: View {
    let evidence: EvidenceViewState
    let workspace: String

    private var statusIcon: (name: String, color: Color) {
        switch evidence.passed {
        case .some(true): ("checkmark.seal.fill", .green)
        case .some(false): ("xmark.seal.fill", .red)
        case .none: ("clock.badge.questionmark", .secondary)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: statusIcon.name)
                .font(.system(size: 10))
                .foregroundStyle(statusIcon.color)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(evidence.kind.uppercased())
                        .font(.system(size: 7.5, weight: .bold, design: .rounded))
                        .tracking(0.8)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4.5)
                        .padding(.vertical, 1.5)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                    Text(evidence.summary)
                        .font(.system(size: 10.5, weight: .medium))
                        .lineLimit(2)
                }
                if let detail = evidence.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
                if let file = evidence.file, !file.isEmpty {
                    Button {
                        VSCodeLink.open(workspace: workspace, path: file, line: evidence.line)
                    } label: {
                        Label(URL(filePath: file).lastPathComponent, systemImage: "arrow.up.forward.square")
                            .font(.system(size: 8.5, weight: .medium))
                            .foregroundStyle(Theme.accentA)
                    }
                    .buttonStyle(.plain)
                    .help("Open \(file) in VS Code")
                    .accessibilityLabel("Open evidence source \(file) in VS Code")
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        let verdict = switch evidence.passed {
        case .some(true): "passed"
        case .some(false): "failed"
        case .none: "pending"
        }
        return "\(evidence.kind) evidence, \(verdict): \(evidence.summary)"
    }
}

/// A run or recovery boundary in the task timeline.
struct RunBoundaryRow: View {
    let boundary: RunBoundaryViewState

    private var isRecovery: Bool { boundary.kind == "recovery" }

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: isRecovery ? "arrow.clockwise.circle.fill" : "flag.circle.fill")
                .font(.system(size: 10))
                .foregroundStyle(isRecovery ? .orange : Theme.accentA)
            Text(boundary.label)
                .font(.system(size: 10.5))
                .lineLimit(2)
            Spacer()
            if let at = boundary.at {
                Text(at.formatted(.relative(presentation: .named)))
                    .font(.system(size: 8.5))
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(isRecovery ? "Recovery" : "Run") boundary: \(boundary.label)"
        )
    }
}

/// A queued task with reorder and remove affordances driven by injected closures.
struct QueueRow: View {
    let position: Int
    let total: Int
    let objective: String
    var onMoveUp: (() -> Void)?
    var onMoveDown: (() -> Void)?
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Text("\(position)")
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .foregroundStyle(.secondary)
                .frame(width: 16, height: 16)
                .background(Color.primary.opacity(0.06), in: Circle())
            Text(objective)
                .font(.system(size: 10.5))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 2) {
                reorderButton(systemImage: "chevron.up", help: "Move up in queue", action: onMoveUp, enabled: position > 1)
                reorderButton(systemImage: "chevron.down", help: "Move down in queue", action: onMoveDown, enabled: position < total)
                if onRemove != nil {
                    reorderButton(systemImage: "xmark", help: "Remove from queue", action: onRemove, enabled: true)
                }
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Queued task \(position) of \(total): \(objective)")
    }

    @ViewBuilder
    private func reorderButton(systemImage: String, help: String, action: (() -> Void)?, enabled: Bool) -> some View {
        Button {
            action?()
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(action != nil && enabled ? AnyShapeStyle(.secondary) : AnyShapeStyle(.quaternary))
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(action == nil || !enabled)
        .help(action == nil ? "\(help) — not available yet" : help)
        .accessibilityLabel(help)
    }
}
