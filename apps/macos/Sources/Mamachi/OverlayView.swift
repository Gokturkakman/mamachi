import SwiftUI

struct OverlayView: View {
    @ObservedObject var model: AppModel
    @State private var message = ""

    var body: some View {
        VStack(spacing: 0) {
            compactHeader
            if let error = model.errorMessage {
                errorBanner(error)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
            }
            if model.drawerExpanded {
                Divider().opacity(0.35)
                drawer
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(width: 480)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(.white.opacity(0.16), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.25), radius: 22, y: 10)
        .padding(24)
        .animation(.snappy(duration: 0.25), value: model.drawerExpanded)
    }

    private var compactHeader: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                statusDot
                Text(model.voiceState.label)
                    .font(.system(size: 12, weight: .semibold))
                repositoryChip
                Spacer()
                if model.activeTask != nil {
                    Label("Coder active", systemImage: "hammer.fill")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                Button {
                    model.drawerExpanded.toggle()
                } label: {
                    Image(systemName: model.drawerExpanded ? "chevron.down" : "chevron.up")
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .help(model.drawerExpanded ? "Collapse task drawer" : "Expand task drawer")
            }

            HStack(spacing: 16) {
                Button(action: model.toggleEngagement) {
                    ZStack(alignment: .bottomTrailing) {
                        ThinkingOrbView(
                            state: model.voiceState,
                            microphoneLevel: model.microphoneLevel,
                            size: 88
                        )
                        Circle()
                            .fill(model.isEngaged ? Color.accentColor : Color.primary.opacity(0.1))
                            .frame(width: 25, height: 25)
                            .overlay {
                                Image(systemName: model.isEngaged ? "waveform" : "mic.fill")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(model.isEngaged ? .white : .primary)
                            }
                    }
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .help(model.isEngaged ? "Sleep microphone (⌘⇧Space)" : "Talk to Mamachi (⌘⇧Space)")

                VStack(alignment: .leading, spacing: 5) {
                    Text(currentTranscript)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(currentTranscriptIsPlaceholder ? .secondary : .primary)
                        .contentTransition(.interpolate)
                        .animation(.easeOut(duration: 0.12), value: currentTranscript)
                        .lineLimit(4)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let activity = model.activeTask?.recentActivity {
                        Label(activity, systemImage: "hammer.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .padding(.bottom, 2)
        }
        .padding(14)
    }

    private var drawer: some View {
        VStack(spacing: 14) {
            taskSection
            if !model.pendingContexts.isEmpty {
                capturedContextSection
            }
            transcriptSection
            HStack(spacing: 8) {
                TextField("Ask, clarify, or steer…", text: $message)
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
            .frame(height: 38)
            .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
        .padding(14)
        .frame(height: 420)
    }

    @ViewBuilder
    private var taskSection: some View {
        if let task = model.activeTask {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label("Active task", systemImage: "terminal")
                        .font(.system(size: 12, weight: .semibold))
                    Spacer()
                    Text(task.state.replacingOccurrences(of: "_", with: " ").uppercased())
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(taskStateColor(task.state))
                }
                Text(task.objective)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(2)
                HStack(spacing: 8) {
                    if task.state == "running" || task.state == "pause_requested" {
                        taskButton("Pause", systemImage: "pause.fill") { model.controlActiveTask("pause") }
                    } else if task.state == "paused" {
                        taskButton("Resume", systemImage: "play.fill") { model.controlActiveTask("resume") }
                    }
                    if !task.isTerminal {
                        taskButton("Cancel", systemImage: "xmark") { model.controlActiveTask("cancel") }
                    }
                    Spacer()
                    Text("Revision \(task.revision)")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(12)
            .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        } else if let latest = model.tasks.last {
            VStack(alignment: .leading, spacing: 6) {
                Label(latest.state.capitalized, systemImage: latest.state == "completed" ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(taskStateColor(latest.state))
                Text(latest.terminalSummary ?? latest.objective)
                    .font(.system(size: 12))
                    .lineLimit(3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        } else {
            HStack {
                Image(systemName: "sparkles")
                Text("Describe a coding change to begin.")
                Spacer()
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .padding(12)
            .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        }

        if !model.queue.isEmpty {
            HStack(spacing: 7) {
                Image(systemName: "list.bullet")
                Text("\(model.queue.count) queued")
                Text(model.queue.compactMap(taskObjective).joined(separator: "  ·  "))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
            .font(.system(size: 10, weight: .medium))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var capturedContextSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Captured context", systemImage: "paperclip")
                    .font(.system(size: 10, weight: .semibold))
                Spacer()
                Text("attaches once")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(model.pendingContexts) { context in
                        Label(context.summary, systemImage: contextIcon(context.kind))
                            .font(.system(size: 9, weight: .medium))
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(.primary.opacity(0.06), in: Capsule())
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var transcriptSection: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("Conversation")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                Button("Clear") { model.clearTranscripts() }
                    .buttonStyle(.plain)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(model.transcripts.suffix(16)) { entry in
                            transcriptRow(speaker: entry.speaker, text: entry.text, streaming: false)
                                .id(entry.id)
                        }
                        if !model.liveUserTranscript.isEmpty {
                            transcriptRow(speaker: .user, text: model.liveUserTranscript, streaming: true)
                        }
                        if !model.liveAssistantTranscript.isEmpty {
                            transcriptRow(speaker: .mamachi, text: model.liveAssistantTranscript, streaming: true)
                        }
                        Color.clear.frame(height: 1).id("conversation-bottom")
                    }
                }
                .onChange(of: model.transcripts.count) {
                    proxy.scrollTo("conversation-bottom", anchor: .bottom)
                }
                .onChange(of: model.liveUserTranscript) {
                    withAnimation(.easeOut(duration: 0.12)) {
                        proxy.scrollTo("conversation-bottom", anchor: .bottom)
                    }
                }
                .onChange(of: model.liveAssistantTranscript) {
                    withAnimation(.easeOut(duration: 0.12)) {
                        proxy.scrollTo("conversation-bottom", anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxHeight: .infinity)
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
                .animation(.easeOut(duration: 0.1), value: text)
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

    private var repositoryChip: some View {
        Button(action: model.chooseWorkspace) {
            HStack(spacing: 4) {
                Image(systemName: "folder.fill")
                Text(URL(filePath: model.workspace).lastPathComponent)
                    .lineLimit(1)
            }
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.primary.opacity(0.06), in: Capsule())
        }
        .buttonStyle(.plain)
        .help(model.workspace)
    }


    private var statusDot: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 7, height: 7)
            .shadow(color: statusColor.opacity(0.5), radius: 4)
    }

    private var statusColor: Color {
        switch model.voiceState {
        case .connected, .listening: .green
        case .connecting, .thinking: .orange
        case .speaking: .blue
        case .error: .red
        case .disconnected: .secondary
        }
    }

    private var currentTranscript: String {
        let text: String
        if !model.liveAssistantTranscript.isEmpty {
            text = model.liveAssistantTranscript
        } else if !model.liveUserTranscript.isEmpty {
            text = model.liveUserTranscript
        } else if let last = model.transcripts.last {
            text = last.text
        } else if !model.daemonConnected {
            return "Starting local coding daemon…"
        } else {
            return model.isEngaged ? "I'm listening." : "Press ⌘⇧Space to talk."
        }
        let words = text.split(whereSeparator: { $0.isWhitespace })
        guard words.count > 18 else { return text }
        return "… " + words.suffix(18).joined(separator: " ")
    }

    private var currentTranscriptIsPlaceholder: Bool {
        model.liveAssistantTranscript.isEmpty && model.liveUserTranscript.isEmpty && model.transcripts.isEmpty
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(message).lineLimit(2)
            if model.needsAPIKey {
                Button(action: model.openSettings) {
                    Text("Add key")
                        .fontWeight(.bold)
                }
                .buttonStyle(.plain)
            }
            Spacer()
            Button(action: model.dismissError) { Image(systemName: "xmark") }
                .buttonStyle(.plain)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.red)
        .padding(10)
        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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

    private func taskStateColor(_ state: String) -> Color {
        switch state {
        case "completed": .green
        case "failed", "cancelled": .red
        case "paused", "pause_requested": .orange
        default: .blue
        }
    }

    private func contextIcon(_ kind: String) -> String {
        switch kind {
        case "selection": "selection.pin.in.out"
        case "diagnostics": "stethoscope"
        case "terminal_excerpt": "terminal"
        default: "doc.text"
        }
    }

    private func taskObjective(_ id: String) -> String? {
        model.tasks.first(where: { $0.id == id })?.objective
    }

    private func sendMessage() {
        model.sendText(message)
        message = ""
    }
}
