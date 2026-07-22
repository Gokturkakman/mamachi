import SwiftUI

struct OverlayView: View {
    @ObservedObject var model: AppModel
    @State private var message = ""

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
                    .frame(width: 25, height: 25)
                    .background(.regularMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .help("Open current conversation")
        }
        .frame(width: 112, height: 112)
        .background(.ultraThinMaterial, in: Circle())
        .overlay {
            Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.24), radius: 18, y: 8)
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
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(.white.opacity(0.16), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.25), radius: 24, y: 10)
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

            Button(action: model.openSettings) {
                Image(systemName: "gearshape")
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .help("Settings")

            Button {
                model.drawerExpanded = false
            } label: {
                Image(systemName: "chevron.down")
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .help("Collapse to orb")
        }
    }

    @ViewBuilder
    private var currentTaskSection: some View {
        if let task = model.activeTask {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Current task", systemImage: task.state == "awaiting_user" ? "questionmark.bubble.fill" : "terminal")
                        .font(.system(size: 11, weight: .semibold))
                    Spacer()
                    Text(task.state.replacingOccurrences(of: "_", with: " ").uppercased())
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(taskStateColor(task.state))
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
                        taskButton("Pause", systemImage: "pause.fill") { model.controlActiveTask("pause") }
                    } else if task.state == "paused" || task.state == "awaiting_user" {
                        taskButton("Resume", systemImage: "play.fill") { model.controlActiveTask("resume") }
                    }
                    if !task.isTerminal {
                        taskButton("Cancel", systemImage: "xmark") { model.controlActiveTask("cancel") }
                    }
                    Spacer()
                    if !model.queue.isEmpty {
                        Label("\(model.queue.count) queued", systemImage: "list.bullet")
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(11)
            .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        } else if let latest = model.tasks.last {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: latest.state == "completed" ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(taskStateColor(latest.state))
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
            .padding(11)
            .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
    }

    private var transcriptSection: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("Current conversation")
                    .font(.system(size: 11, weight: .semibold))
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
            .onSubmit(sendMessage)
            Button(action: sendMessage) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22))
            }
            .buttonStyle(.plain)
            .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func transcriptRow(speaker: TranscriptEntry.Speaker, text: String, streaming: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(speaker == .user ? "You" : "M")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(speaker == .user ? .secondary : Color.accentColor)
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
                    speaker == .user ? Color.primary.opacity(0.05) : Color.accentColor.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .opacity(streaming ? 0.92 : 1)
        }
    }

    private func taskButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 10, weight: .semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.primary.opacity(0.07), in: Capsule())
        }
        .buttonStyle(.plain)
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
        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var interactionMode: Binding<InteractionMode> {
        Binding(get: { model.interactionMode }, set: model.setInteractionMode)
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

    private func taskStateColor(_ state: String) -> Color {
        switch state {
        case "completed": .green
        case "failed", "cancelled": .red
        case "paused", "pause_requested", "awaiting_user": .orange
        default: .blue
        }
    }

    private func sendMessage() {
        model.sendText(message)
        message = ""
    }
}
