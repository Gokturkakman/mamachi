import AppKit
import SwiftUI

struct MenuBarView: View {
    @ObservedObject var model: AppModel
    let showOverlay: () -> Void
    let hideOverlay: () -> Void

    var body: some View {
        Group {
            Button {
                showOverlay()
                model.toggleEngagement()
            } label: {
                Label(model.isEngaged ? "Sleep microphone" : "Talk to Mamachi", systemImage: model.isEngaged ? "mic.slash" : "mic")
            }
            .keyboardShortcut(.space, modifiers: [.command, .shift])

            Button {
                model.setInteractionMode(.text)
                model.drawerExpanded = true
                showOverlay()
            } label: {
                Label("Open Silent Chat", systemImage: "text.bubble")
            }

            if model.pendingBrief != nil {
                Button {
                    showOverlay()
                    model.toggleEngagement()
                } label: {
                    Label("Listen to Waiting Update", systemImage: "bell.badge")
                }
            }

            Button("Show Overlay", action: showOverlay)
            Button("Hide Overlay", action: hideOverlay)

            Divider()

            if let task = model.activeTask {
                VStack(alignment: .leading) {
                    Text("Coding")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(task.objective)
                        .lineLimit(2)
                    Text(task.state.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if task.state == "paused" || task.state == "awaiting_user" {
                    Button("Resume Coding") { model.controlActiveTask("resume") }
                } else if task.state == "running" || task.state == "pause_requested" {
                    Button("Pause Coding") { model.controlActiveTask("pause") }
                }
                Button("Cancel Coding", role: .destructive) { model.controlActiveTask("cancel") }
            } else {
                Text(model.daemonConnected ? "Coder idle" : "Starting daemon…")
                    .foregroundStyle(.secondary)
            }

            Divider()

            Button {
                model.chooseWorkspace()
            } label: {
                Label(URL(filePath: model.workspace).lastPathComponent, systemImage: "folder")
            }

            Button(action: model.openSettings) {
                Label("Settings…", systemImage: "gear")
            }

            Divider()

            Button("Quit Mamachi", action: model.quitApplication)
                .keyboardShortcut("q")
        }
    }
}
