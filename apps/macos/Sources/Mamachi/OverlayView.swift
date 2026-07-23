import SwiftUI

/// The two expanded-overlay surfaces: the operational task drawer and the
/// live conversation (transcript + composer).
enum OverlaySurface: String, CaseIterable, Identifiable {
    case task
    case conversation

    var id: String { rawValue }
    var label: String { self == .task ? "Task" : "Chat" }
    var systemImage: String { self == .task ? "checklist" : "text.bubble" }
}

struct OverlayView: View {
    @ObservedObject var model: AppModel
    @State private var message = ""
    @FocusState private var composerFocused: Bool
    @State private var surface: OverlaySurface = .conversation
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if model.drawerExpanded {
                expandedPanel
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            } else {
                compactOrb
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
        }
        .padding(16)
        .animation(.smooth(duration: 0.38), value: model.drawerExpanded)
        .onChange(of: model.drawerExpanded) { _, expanded in
            guard expanded, surface == .conversation else { return }
            focusComposerSoon()
        }
        .onChange(of: surface) { _, next in
            guard next == .conversation, model.drawerExpanded else { return }
            focusComposerSoon()
        }
    }

    private var compactOrb: some View {
        GeometryReader { proxy in
            ZStack {
                WindowDragHandle(
                    onClick: compactOrbAction,
                    contextMenuActions: OrbContextMenuActions(
                        openTaskDrawer: {
                            surface = .task
                            model.drawerExpanded = true
                        },
                        openChat: {
                            surface = .conversation
                            model.drawerExpanded = true
                        },
                        openSettings: model.openSettings,
                        hideOverlay: model.hideOverlay,
                        quitApplication: model.quitApplication
                    )
                )
                .clipShape(Capsule())

                HStack(spacing: 7) {
                    Capsule()
                        .fill(compactIndicatorColor)
                        .frame(width: model.isEngaged || model.activeTask != nil ? 22 : 12, height: 3)
                        .shadow(color: compactIndicatorColor.opacity(0.8), radius: 3)
                        .animation(.snappy(duration: 0.2), value: model.isEngaged)
                        .animation(.snappy(duration: 0.2), value: model.activeTaskId)
                    Text(compactIndicatorText)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Button {
                        model.drawerExpanded = true
                    } label: {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Open Mamachi")
                }
                .padding(.leading, 10)
                .padding(.trailing, 5)
                .allowsHitTesting(true)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay {
                Capsule().strokeBorder(Theme.specularEdge, lineWidth: 1)
            }
            .overlay(alignment: .bottom) {
                Capsule()
                    .fill(model.activeTask.map { Theme.statusColor($0.state) } ?? .clear)
                    .frame(height: 1.5)
                    .padding(.horizontal, 12)
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.26 : 0.12), radius: 7, y: 2)
        }
        .help("\(compactOrbHelp). Right-click for app menu and Quit.")
        .accessibilityLabel("\(compactIndicatorText), \(codingStatusLabel)")
    }

    private var microphoneSleeping: Bool {
        model.interactionMode == .voice && !model.isEngaged && model.voiceState == .connected
    }

    private var expandedPanel: some View {
        VStack(spacing: 12) {
            expandedHeader
            workspaceStatusRow
            if let error = model.errorMessage {
                errorBanner(error)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            if let brief = model.pendingBrief, !model.isEngaged {
                briefBanner(brief)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            ForEach(model.pendingConfirmations.prefix(3)) { confirmation in
                approvalCard(confirmation)
            }
            surfacePicker
            if surface == .task {
                taskDrawer
            } else {
                transcriptSection
                composer
            }
        }
        .padding(14)
        .frame(minWidth: 440, maxWidth: .infinity, minHeight: 508, maxHeight: .infinity)
        .background {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(Theme.panelWash)
                }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Theme.specularEdge, lineWidth: 1)
        }
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.30 : 0.13), radius: 12, y: 4)
        .shadow(color: Theme.accentB.opacity(colorScheme == .dark ? 0.08 : 0), radius: 24)
        .animation(.smooth(duration: 0.3), value: model.voiceState)
        .animation(.smooth(duration: 0.3), value: model.interactionMode)
        .animation(.smooth(duration: 0.25), value: surface)
        .onExitCommand { model.drawerExpanded = false }
    }

    /// Repository grounding + coding status, always visible while expanded.
    private var workspaceStatusRow: some View {
        HStack(spacing: 8) {
            RepositoryChip(workspace: model.workspace)
            CodingStatusChip(task: model.activeTask, queueCount: model.queue.count)
            Spacer(minLength: 0)
        }
    }

    private var surfacePicker: some View {
        HStack(spacing: 4) {
            ForEach(OverlaySurface.allCases) { candidate in
                surfaceTab(candidate)
            }
            Spacer()
        }
    }

    private func surfaceTab(_ candidate: OverlaySurface) -> some View {
        let selected = surface == candidate
        return Button {
            surface = candidate
        } label: {
            HStack(spacing: 5) {
                Image(systemName: candidate.systemImage)
                    .font(.system(size: 9, weight: .semibold))
                Text(candidate.label)
                    .font(.system(size: 10.5, weight: .semibold))
                if candidate == .task && taskNeedsAttention {
                    Circle()
                        .fill(.orange)
                        .frame(width: 5, height: 5)
                        .accessibilityLabel("needs attention")
                }
            }
            .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background(
                selected ? AnyShapeStyle(Color.primary.opacity(0.08)) : AnyShapeStyle(Color.clear),
                in: Capsule()
            )
            .overlay {
                Capsule().strokeBorder(selected ? Color.primary.opacity(0.1) : .clear, lineWidth: 1)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(candidate.label) surface")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var taskDrawer: some View {
        TaskDrawerView(
            workspace: model.workspace,
            activeTask: model.activeTask,
            tasks: model.tasks,
            queue: model.queue,
            pendingContexts: model.pendingContexts,
            attentionMessage: model.attentionMessage,
            hasPendingApproval: model.pendingConfirmation != nil,
            onControlTask: model.controlActiveTask,
            onReorderQueue: { taskId, offset in
                model.moveQueuedTask(taskId, up: offset < 0)
            },
            onRemoveQueued: { taskId in
                guard let task = model.tasks.first(where: { $0.id == taskId }) else { return }
                model.cancelQueuedTask(task)
            },
            onRemoveContext: { context in
                model.removeContext(context.id)
            }
        )
    }

    private var expandedHeader: some View {
        HStack(spacing: 11) {
            Button(action: expandedOrbAction) {
                ThinkingOrbView(
                    state: model.voiceState,
                    microphoneLevel: model.microphoneLevel,
                    size: 56
                )
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(compactOrbHelp)

            VStack(alignment: .leading, spacing: 3) {
                Text(currentHeadline)
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(0.1)
                    .lineLimit(1)
                Text(currentDetail)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .contentTransition(.interpolate)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Picker("Mode", selection: interactionMode) {
                ForEach(InteractionMode.allCases) { mode in
                    Image(systemName: mode.systemImage)
                        .help(mode.label)
                        .tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 84)

            GlassIconButton(systemImage: "gearshape", help: "Settings", action: model.openSettings)

            GlassIconButton(systemImage: "power", help: "Quit Mamachi", action: model.quitApplication)
                .keyboardShortcut("q", modifiers: .command)

            GlassIconButton(systemImage: "chevron.down", help: "Collapse to orb") {
                model.drawerExpanded = false
            }
        }
    }

    private var transcriptSection: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                SectionLabel("Current conversation")
                Spacer()
                Button("Clear") { model.clearTranscripts() }
                    .buttonStyle(.plain)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(model.transcripts.suffix(40)) { entry in
                        transcriptRow(speaker: entry.speaker, text: entry.text, streaming: false)
                    }
                    if !model.liveUserTranscript.isEmpty {
                        transcriptRow(speaker: .user, text: model.liveUserTranscript, streaming: true)
                    }
                    if !model.liveAssistantTranscript.isEmpty {
                        transcriptRow(speaker: .mamachi, text: model.liveAssistantTranscript, streaming: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .defaultScrollAnchor(.bottom)
        }
        .frame(maxHeight: .infinity)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField(
                model.interactionMode == .text ? "Message Mamachi silently…" : "Ask, clarify, or steer…",
                text: $message
            )
            .textFieldStyle(.plain)
            .font(.system(size: 12))
            .focused($composerFocused)
            .onSubmit(sendMessage)

            Button(action: sendMessage) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(canSend ? AnyShapeStyle(.white) : AnyShapeStyle(.tertiary))
                    .frame(width: 26, height: 26)
                    .background(
                        canSend ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Color.primary.opacity(0.08)),
                        in: Circle()
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .frame(height: 42)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(
                    composerFocused ? AnyShapeStyle(Theme.brand.opacity(0.55)) : AnyShapeStyle(Color.primary.opacity(0.07)),
                    lineWidth: 1
                )
        }
        .animation(.easeOut(duration: 0.15), value: composerFocused)
    }

    private func transcriptRow(speaker: TranscriptEntry.Speaker, text: String, streaming: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Group {
                if speaker == .mamachi {
                    Text("M")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .frame(width: 18, height: 18)
                        .background(Theme.brand, in: Circle())
                } else {
                    Image(systemName: "person.fill")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 18)
                        .background(Color.primary.opacity(0.06), in: Circle())
                }
            }
            .padding(.top, 4)
            .frame(width: 22, alignment: .leading)

            Text(text)
                .font(.system(size: 12))
                .lineSpacing(3)
                .contentTransition(.interpolate)
                .animation(.easeOut(duration: 0.12), value: text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    speaker == .user
                        ? AnyShapeStyle(Color.primary.opacity(0.05))
                        : AnyShapeStyle(
                            LinearGradient(
                                colors: [Theme.accentA.opacity(0.10), Theme.accentB.opacity(0.08)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        ),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(
                            speaker == .user ? Color.primary.opacity(0.05) : Theme.accentB.opacity(0.13),
                            lineWidth: 1
                        )
                }
                .opacity(streaming ? 0.92 : 1)
        }
    }

    private func approvalCard(_ confirmation: ConfirmationViewState) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Image(systemName: "lock.shield.fill")
                    .foregroundStyle(.orange)
                Text("Permission required")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                Text(confirmation.category.replacingOccurrences(of: "_", with: " ").uppercased())
                    .font(.system(size: 8, weight: .bold, design: .rounded))
                    .foregroundStyle(.orange)
            }
            Text(confirmation.summary)
                .font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
            Text("\(confirmation.toolName) · specification revision \(confirmation.taskRevision)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                PillButton(title: "Reject", systemImage: "xmark") {
                    model.resolveConfirmation(confirmation, decision: "reject")
                }
                PillButton(title: "Approve once", systemImage: "checkmark") {
                    model.resolveConfirmation(confirmation, decision: "approve")
                }
            }
        }
        .padding(12)
        .background(.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(.orange.opacity(0.24), lineWidth: 1)
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(message).lineLimit(2)
            Spacer()
            if model.needsAPIKey {
                Button("Settings", action: model.openSettings)
                    .buttonStyle(.plain)
                    .fontWeight(.semibold)
            }
            Button(action: model.dismissError) { Image(systemName: "xmark") }
                .buttonStyle(.plain)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.red)
        .padding(10)
        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.red.opacity(0.18), lineWidth: 1)
        }
    }

    /// Sleeping-mode affordance: updates queued while the microphone slept.
    private func briefBanner(_ brief: PendingBriefViewState) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "bell.badge.fill")
                .foregroundStyle(Theme.accentA)
            VStack(alignment: .leading, spacing: 1.5) {
                Text(brief.count == 1 ? "A spoken update is waiting" : "\(brief.count) spoken updates are waiting")
                    .font(.system(size: 11, weight: .semibold))
                if !brief.latestSummary.isEmpty {
                    Text(brief.latestSummary)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            PillButton(title: "Listen", systemImage: "play.fill") { model.toggleEngagement() }
        }
        .padding(10)
        .background(Theme.accentA.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Theme.accentA.opacity(0.22), lineWidth: 1)
        }
    }

    private var interactionMode: Binding<InteractionMode> {
        Binding(get: { model.interactionMode }, set: model.setInteractionMode)
    }

    private var canSend: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var currentHeadline: String {
        if let task = model.activeTask {
            return task.state == "awaiting_user" ? "Coder needs input" : "Coder \(task.state.replacingOccurrences(of: "_", with: " "))"
        }
        return model.interactionMode == .text ? "Silent chat" : model.voiceState.label
    }

    private var currentDetail: String {
        if let activity = model.activeTask?.recentActivity { return activity }
        if !model.liveAssistantTranscript.isEmpty { return model.liveAssistantTranscript }
        if !model.liveUserTranscript.isEmpty { return model.liveUserTranscript }
        if let last = model.transcripts.last { return last.text }
        return model.interactionMode == .text ? "Type below; responses stay silent." : "Press ⌥Space to talk."
    }

    private var compactOrbHelp: String {
        if model.interactionMode == .text { return "Open silent chat" }
        return model.isEngaged ? "Sleep microphone (⌥Space)" : "Talk to Mamachi (⌥Space)"
    }

    private var repositoryName: String {
        let component = URL(filePath: model.workspace, directoryHint: .isDirectory).lastPathComponent
        return component.isEmpty ? model.workspace : component
    }

    private var codingStatusLabel: String {
        guard let task = model.activeTask else { return "coder idle" }
        return "coder \(task.state.replacingOccurrences(of: "_", with: " "))"
    }

    private var compactIndicatorText: String {
        if taskNeedsAttention { return "Needs you" }
        if model.activeTask != nil { return "Coding" }
        if model.isEngaged { return model.voiceState.label }
        if model.pendingBrief != nil { return "Update ready" }
        return microphoneSleeping ? "Sleeping" : "Ready"
    }

    private var compactIndicatorColor: Color {
        if taskNeedsAttention { return .orange }
        if let task = model.activeTask { return Theme.statusColor(task.state) }
        if model.voiceState == .error { return .red }
        return model.isEngaged ? Theme.accentA : .secondary
    }

    private var taskNeedsAttention: Bool {
        model.attentionMessage != nil
            || model.pendingConfirmation != nil
            || model.activeTask?.state == "awaiting_user"
    }

    private func compactOrbAction() {
        if model.interactionMode == .text {
            model.drawerExpanded = true
        } else {
            model.toggleEngagement()
        }
    }

    private func expandedOrbAction() {
        if model.interactionMode == .voice {
            model.toggleEngagement()
        }
    }

    private func sendMessage() {
        model.sendText(message)
        message = ""
    }

    /// Focuses the composer once the panel has become key after expanding.
    private func focusComposerSoon() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(420))
            composerFocused = true
        }
    }
}

