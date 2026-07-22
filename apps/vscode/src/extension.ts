import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import WebSocket, { type RawData } from "ws";
import * as vscode from "vscode";

interface ConnectionDescriptor {
  version: 1;
  pid: number;
  port: number;
  token: string;
  workspace: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MamachiBridge implements vscode.Disposable {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #connectionPath =
    process.env["MAMACHI_CONNECTION_PATH"] ?? join(homedir(), "Library", "Application Support", "Mamachi", "connection.json");
  #socket: WebSocket | null = null;
  #connecting: Promise<void> | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #disposed = false;

  onStatus: (connected: boolean, detail: string) => void = () => {};
  onEvent: (type: string, payload: Record<string, unknown>) => void = () => {};

  start(): void {
    void this.connect();
    this.#reconnectTimer = setInterval(() => {
      if (!this.#socket && !this.#connecting) void this.connect();
    }, 2_000);
  }

  connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async request(type: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mamachi is not connected");
    const id = crypto.randomUUID();
    const message = JSON.stringify({ version: 1, id, type, payload });
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeout = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`Mamachi request timed out: ${type}`));
    }, 10_000);
    this.#pending.set(id, { resolve, reject, timeout });
    socket.send(message, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      this.#pending.delete(id);
      reject(error);
    });
    return promise;
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#reconnectTimer ?? undefined);
    this.#reconnectTimer = null;
    this.#socket?.close(1000, "VS Code extension deactivated");
    this.#socket = null;
    this.#rejectPending(new Error("Mamachi extension deactivated"));
  }

  async #open(): Promise<void> {
    let descriptor: ConnectionDescriptor;
    try {
      const parsed = JSON.parse(await readFile(this.#connectionPath, "utf8")) as unknown;
      descriptor = this.#parseDescriptor(parsed);
    } catch {
      this.onStatus(false, "Start the Mamachi app");
      throw new Error("Mamachi connection descriptor is unavailable");
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/ws`, {
      headers: { Authorization: `Bearer ${descriptor.token}` },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error("Mamachi connection timed out"));
    }, 5_000);

    socket.once("open", () => {
      if (this.#disposed) {
        socket.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      this.#socket = socket;
      this.onStatus(true, `Connected on port ${descriptor.port}`);
      resolve();
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) this.#handleMessage(data);
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      if (this.#socket === socket) this.#socket = null;
      this.onStatus(false, "Reconnecting…");
      this.#rejectPending(new Error("Mamachi connection closed"));
      if (!settled) {
        settled = true;
        reject(new Error("Mamachi connection closed during setup"));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    await promise;
  }

  #handleMessage(data: RawData): void {
    let event: unknown;
    try {
      event = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }
    if (!isObject(event) || typeof event["type"] !== "string") return;
    const payload = isObject(event["payload"]) ? event["payload"] : {};
    if (event["type"] === "response") {
      const requestId = payload["requestId"];
      if (typeof requestId !== "string") return;
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(requestId);
      if (payload["ok"] === true) pending.resolve(payload["result"]);
      else pending.reject(new Error(typeof payload["error"] === "string" ? payload["error"] : "Mamachi request failed"));
      return;
    }
    this.onEvent(event["type"], payload);
  }

  #parseDescriptor(value: unknown): ConnectionDescriptor {
    if (
      !isObject(value) ||
      value["version"] !== 1 ||
      typeof value["pid"] !== "number" ||
      typeof value["port"] !== "number" ||
      typeof value["token"] !== "string" ||
      typeof value["workspace"] !== "string"
    ) {
      throw new Error("Mamachi connection descriptor is invalid");
    }
    return value as unknown as ConnectionDescriptor;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
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
  bridge.onEvent = (type, payload) => {
    if (type === "context.captured" && typeof payload["summary"] === "string") {
      status.tooltip = `Attached once: ${payload["summary"]}`;
    }
  };
  bridge.start();

  async function focusWorkspace(): Promise<vscode.WorkspaceFolder> {
    const folder = activeWorkspace();
    if (!folder) throw new Error("Open a VS Code workspace first");
    await bridge.request("workspace.focus", { path: folder.uri.fsPath });
    return folder;
  }

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

  context.subscriptions.push(
    bridge,
    status,
    vscode.commands.registerCommand("mamachi.captureActiveFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return void vscode.window.showWarningMessage("Open a file to capture it for Mamachi.");
      await capture({
        kind: "active_file",
        path: editor.document.uri.fsPath,
        language: editor.document.languageId,
      });
    }),
    vscode.commands.registerCommand("mamachi.captureSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return void vscode.window.showWarningMessage("Select code before capturing it for Mamachi.");
      }
      await capture({
        kind: "selection",
        path: editor.document.uri.fsPath,
        language: editor.document.languageId,
        selection: editor.document.getText(editor.selection),
        range: rangeJSON(editor.selection),
      });
    }),
    vscode.commands.registerCommand("mamachi.captureDiagnostics", async () => {
      const folder = activeWorkspace();
      if (!folder) return void vscode.window.showWarningMessage("Open a workspace before capturing diagnostics.");
      const editor = vscode.window.activeTextEditor;
      const diagnostics = (editor ? [[editor.document.uri, vscode.languages.getDiagnostics(editor.document.uri)] as const] : vscode.languages.getDiagnostics())
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
      await capture({
        kind: "diagnostics",
        ...(editor ? { path: editor.document.uri.fsPath } : {}),
        diagnostics,
      });
    }),
    vscode.commands.registerCommand("mamachi.captureTerminalSelection", async () => {
      if (!vscode.window.activeTerminal) {
        return void vscode.window.showWarningMessage("Focus a terminal and select its output first.");
      }
      await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
      const excerpt = (await vscode.env.clipboard.readText()).slice(0, 32_000);
      if (!excerpt.trim()) return void vscode.window.showWarningMessage("The terminal selection is empty.");
      const choice = await vscode.window.showInformationMessage(
        "Attach the copied terminal selection to Mamachi's next coding task?",
        { modal: true, detail: excerpt.slice(0, 1_000) },
        "Attach",
      );
      if (choice === "Attach") await capture({ kind: "terminal_excerpt", terminalExcerpt: excerpt });
    }),
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
}

export function deactivate(): void {}
