import { isAbsolute, relative } from "node:path";
import * as vscode from "vscode";
import { MamachiBridge, type EditorContextKind } from "./realtime-client";
import type { DomainEventEnvelope } from "./generated/protocol.generated";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeWorkspace(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function rangeJSON(range: vscode.Range): Record<string, unknown> {
  return {
    start: { line: range.start.line + 1, character: range.start.character + 1 },
    end: { line: range.end.line + 1, character: range.end.character + 1 },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const bridge = new MamachiBridge();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = "mamachi.showStatus";
  status.name = "Mamachi";
  status.text = "$(waveform) Mamachi";
  status.tooltip = "Connecting to Mamachi…";
  status.show();

  let connected = false;
  let statusDetail = "Starting";
  bridge.onStatus = (isConnected, detail) => {
    connected = isConnected;
    statusDetail = detail;
    status.text = isConnected ? "$(waveform) Mamachi" : "$(debug-disconnect) Mamachi";
    status.tooltip = detail;
  };
  let focusedWorkspacePath: string | null = null;
  let focusInFlight: { path: string; promise: Promise<void> } | null = null;
  bridge.onStateChange = (state) => {
    if (state !== "connected") focusedWorkspacePath = null;
  };
  bridge.onEvent = (type, payload: Record<string, unknown> | DomainEventEnvelope) => {
    if (type === "context.captured" && isObject(payload) && typeof payload["summary"] === "string") {
      status.tooltip = `Attached once: ${payload["summary"]}`;
    }
  };
  async function focusWorkspace(): Promise<vscode.WorkspaceFolder> {
    const folder = activeWorkspace();
    if (!folder) throw new Error("Open a VS Code workspace first");
    const path = folder.uri.fsPath;
    if (bridge.state === "connected" && focusedWorkspacePath === path) return folder;
    if (focusInFlight?.path === path) {
      await focusInFlight.promise;
      return folder;
    }
    if (focusInFlight) await focusInFlight.promise.catch(() => {});
    const promise = bridge.request("workspace.focus", { path }).then(() => {
      if (bridge.state === "connected") focusedWorkspacePath = path;
    });
    focusInFlight = { path, promise };
    try {
      await promise;
    } finally {
      if (focusInFlight?.promise === promise) focusInFlight = null;
    }
    return folder;
  }

  const dirtyDocuments = new Set<string>();
  const desiredEditorStates = new Map<string, { revision: number; payload: Record<string, unknown> }>();
  const editorStateInFlight = new Set<string>();
  let editorStateRevision = 0;

  async function flushEditorState(path: string): Promise<void> {
    if (editorStateInFlight.has(path)) return;
    editorStateInFlight.add(path);
    try {
      for (;;) {
        const desired = desiredEditorStates.get(path);
        if (!desired) return;
        await bridge.request("editor.state", desired.payload);
        if (desiredEditorStates.get(path)?.revision === desired.revision) desiredEditorStates.delete(path);
      }
    } catch {
      // The latest state remains queued and is retried by onReady.
    } finally {
      editorStateInFlight.delete(path);
    }
  }

  async function reportEditorState(document: vscode.TextDocument, open: boolean): Promise<void> {
    if (document.uri.scheme !== "file") return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return;
    const path = document.uri.fsPath;
    if (document.isDirty) dirtyDocuments.add(path);
    else dirtyDocuments.delete(path);
    desiredEditorStates.set(path, {
      revision: ++editorStateRevision,
      payload: {
        workspace: folder.uri.fsPath,
        path,
        version: document.version,
        dirty: document.isDirty,
        open,
      },
    });
    await flushEditorState(path);
  }

  bridge.onReady = () => {
    void focusWorkspace().catch(() => {});
    for (const document of vscode.workspace.textDocuments) {
      const path = document.uri.fsPath;
      if (!desiredEditorStates.has(path) && !editorStateInFlight.has(path)) void reportEditorState(document, true);
    }
  };

  function requireCaptureWorkspace(expectedWorkspace?: string): vscode.WorkspaceFolder {
    const folder = activeWorkspace();
    if (!folder) throw new Error("Open a VS Code workspace before capturing editor context.");
    if (expectedWorkspace && folder.uri.fsPath !== expectedWorkspace) {
      throw new Error("The requested editor context workspace is not active in this VS Code window.");
    }
    return folder;
  }

  async function buildCapturePayload(kind: EditorContextKind, expectedWorkspace?: string): Promise<Record<string, unknown>> {
    const folder = requireCaptureWorkspace(expectedWorkspace);
    const editor = vscode.window.activeTextEditor;
    if (kind === "active_file") {
      if (!editor || vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath !== folder.uri.fsPath) {
        throw new Error("Open a file in the requested workspace before capturing the active file.");
      }
      return {
        kind,
        path: editor.document.uri.fsPath,
        language: editor.document.languageId,
        content: editor.document.getText().slice(0, 96_000),
      };
    }
    if (kind === "selection") {
      if (
        !editor ||
        editor.selection.isEmpty ||
        vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath !== folder.uri.fsPath
      ) {
        throw new Error("Select code in the requested workspace before capturing a selection.");
      }
      return {
        kind,
        path: editor.document.uri.fsPath,
        language: editor.document.languageId,
        selection: editor.document.getText(editor.selection).slice(0, 96_000),
        range: rangeJSON(editor.selection),
      };
    }
    if (kind === "diagnostics") {
      const diagnostics = (
        editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath === folder.uri.fsPath
          ? [[editor.document.uri, vscode.languages.getDiagnostics(editor.document.uri)] as const]
          : vscode.languages.getDiagnostics()
      )
        .filter(([uri]) => {
          const path = relative(folder.uri.fsPath, uri.fsPath);
          return path !== "" && !path.startsWith("..") && !isAbsolute(path);
        })
        .flatMap(([uri, entries]) =>
          entries.slice(0, 100).map((diagnostic) => ({
            path: uri.fsPath,
            range: rangeJSON(diagnostic.range),
            severity: vscode.DiagnosticSeverity[diagnostic.severity],
            message: diagnostic.message,
            source: diagnostic.source ?? null,
            code: typeof diagnostic.code === "object" ? diagnostic.code.value : (diagnostic.code ?? null),
          })),
        )
        .slice(0, 200);
      return {
        kind,
        ...(editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath === folder.uri.fsPath
          ? { path: editor.document.uri.fsPath }
          : {}),
        diagnostics,
      };
    }
    if (!vscode.window.activeTerminal) {
      throw new Error("Focus a terminal and select its output before capturing a terminal excerpt.");
    }
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const excerpt = (await vscode.env.clipboard.readText()).slice(0, 32_000);
    if (!excerpt.trim()) throw new Error("The terminal selection is empty.");
    const choice = await vscode.window.showInformationMessage(
      "Attach the copied terminal selection to Mamachi's next coding task?",
      { modal: true, detail: excerpt.slice(0, 1_000) },
      "Attach",
    );
    if (choice !== "Attach") throw new Error("Terminal excerpt capture was not confirmed.");
    return { kind, terminalExcerpt: excerpt };
  }

  bridge.onEditorContextRequest = async (request) => {
    const captures: Array<{ kind: EditorContextKind; payload: Record<string, unknown> }> = [];
    const errors: Array<{ kind: EditorContextKind; error: string }> = [];
    for (const kind of request.kinds) {
      try {
        const payload = await buildCapturePayload(kind, request.workspace);
        const { kind: capturedKind, ...content } = payload;
        captures.push({ kind: capturedKind as EditorContextKind, payload: content });
      } catch (error) {
        errors.push({ kind, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { captures, errors };
  };

  async function capture(payload: Record<string, unknown>): Promise<void> {
    try {
      const folder = await focusWorkspace();
      const result = await bridge.request("context.capture", {
        ...payload,
        workspace: folder.uri.fsPath,
      });
      const summary = isObject(result) && typeof result["summary"] === "string" ? result["summary"] : "Editor context captured";
      void vscode.window.showInformationMessage(`Mamachi: ${summary} will attach to the next coding task.`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function captureKind(kind: EditorContextKind): Promise<void> {
    try {
      await capture(await buildCapturePayload(kind));
    } catch (error) {
      void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
    }
  }

  context.subscriptions.push(
    bridge,
    status,
    vscode.commands.registerCommand("mamachi.captureActiveFile", () => captureKind("active_file")),
    vscode.commands.registerCommand("mamachi.captureSelection", () => captureKind("selection")),
    vscode.commands.registerCommand("mamachi.captureDiagnostics", () => captureKind("diagnostics")),
    vscode.commands.registerCommand("mamachi.captureTerminalSelection", () => captureKind("terminal_excerpt")),
    vscode.commands.registerCommand("mamachi.focusWorkspace", async () => {
      try {
        const folder = await focusWorkspace();
        void vscode.window.showInformationMessage(`Mamachi will target ${folder.name}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand("mamachi.showStatus", () => {
      void vscode.window.showInformationMessage(`Mamachi is ${connected ? "connected" : "disconnected"}. ${statusDetail}`);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void reportEditorState(document, true);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0 || dirtyDocuments.has(event.document.uri.fsPath)) return;
      void reportEditorState(event.document, true);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void reportEditorState(document, true);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      dirtyDocuments.delete(document.uri.fsPath);
      void reportEditorState(document, false);
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void focusWorkspace().catch(() => {});
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (vscode.window.state.focused) void focusWorkspace().catch(() => {});
    }),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const parameters = new URLSearchParams(uri.query);
        const path = parameters.get("path");
        if (!path) return;
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        const line = Math.max(0, Number(parameters.get("line") ?? "1") - 1);
        const character = Math.max(0, Number(parameters.get("character") ?? "1") - 1);
        const position = new vscode.Position(line, character);
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
      },
    }),
  );
  bridge.start();
}

export function deactivate(): void {}
