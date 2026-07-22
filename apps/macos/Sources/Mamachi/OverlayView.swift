import SwiftUI

struct OverlayView: View {
    @ObservedObject var model: AppModel
    @State private var message = ""
    @FocusState private var composerFocused: Bool

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
    }

    private var compactOrb: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: compactOrbAction) {
                ThinkingOrbView(
                    state: model.voiceState,
                    microphoneLevel: model.microphoneLevel,
                    size: 92
                )
                .frame(width: 108, height: 108)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(compactOrbHelp)

            Button {
                model.drawerExpanded = true
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 25, height: 25)
                    .background(.regularMaterial, in: Circle())
                    .overlay {
                        Circle().strokeBorder(.white.opacity(0.14), lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .help("Open current conversation")
        }
        .frame(width: 112, height: 112)
        .background(.ultraThinMaterial, in: Circle())
        .overlay {
            Circle().strokeBorder(Theme.specularEdge, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.26), radius: 18, y: 8)
    }

    private var expandedPanel: some View {
        VStack(spacing: 12) {
            expandedHeader
            if let error = model.errorMessage {
                errorBanner(error)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            currentTaskSection
            transcriptSection
            composer
        }
        .padding(14)
        .frame(width: 480, height: 620)
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
        .shadow(color: .black.opacity(0.28), radius: 26, y: 10)
        .shadow(color: Theme.accentB.opacity(0.08), radius: 36)
        .animation(.smooth(duration: 0.3), value: model.voiceState)
        .animation(.smooth(duration: 0.3), value: model.interactionMode)
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

            GlassIconButton(systemImage: "chevron.down", help: "Collapse to orb") {
                model.drawerExpanded = false
            }
        }
    }

    @ViewBuilder
    private var currentTaskSection: some View {
        if let task = model.activeTask {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: task.state == "awaiting_user" ? "questionmark.bubble.fill" : "terminal")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.brand)
                    SectionLabel("Current task")
                    Spacer()
                    StatusChip(state: task.state)
                }
                Text(task.objective)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(2)
                if task.state == "awaiting_user", let question = model.attentionMessage {
                    Text(question)
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let activity = task.recentActivity {
                    Text(activity)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    if task.state == "running" || task.state == "pause_requested" {
                        PillButton(title: "Pause", systemImage: "pause.fill") { model.controlActiveTask("pause") }
                    } else if task.state == "paused" || task.state == "awaiting_user" {
                        PillButton(title: "Resume", systemImage: "play.fill") { model.controlActiveTask("resume") }
                    }
                    if !task.isTerminal {
                        PillButton(title: "Cancel", systemImage: "xmark") { model.controlActiveTask("cancel") }
                    }
                    Spacer()
                    if !model.queue.isEmpty {
                        Label("\(model.queue.count) queued", systemImage: "list.bullet")
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(12)
            .glassCard()
        } else if let latest = model.tasks.last {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: latest.state == "completed" ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(Theme.statusColor(latest.state))
                VStack(alignment: .leading, spacing: 3) {
                    Text(latest.state.capitalized)
                        .font(.system(size: 11, weight: .semibold))
                    Text(latest.terminalSummary ?? latest.objective)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
            }
            .padding(12)
            .glassCard()
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
                    ForEach(model.transcripts.suffix(16)) { entry in
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
        return model.interactionMode == .text ? "Type below; responses stay silent." : "Press ⌘⇧Space to talk."
    }

    private var compactOrbHelp: String {
        if model.interactionMode == .text { return "Open silent chat" }
        return model.isEngaged ? "Sleep microphone (⌘⇧Space)" : "Talk to Mamachi (⌘⇧Space)"
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
}
