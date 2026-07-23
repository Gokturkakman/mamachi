import type { ContextKind } from "./artifact-store.ts";

/// The kinds VS Code can capture; deliberately narrower than `ContextKind`
/// (daemon-internal kinds like `screenshot` are not editor-capturable).
export const editorContextKinds: readonly ContextKind[] = ["active_file", "selection", "diagnostics", "terminal_excerpt"];

export interface EditorContextCapture {
  kind: ContextKind;
  payload: Record<string, unknown>;
}

export interface EditorContextError {
  kind: ContextKind;
  error: string;
}

export interface EditorContextResponse {
  captures: EditorContextCapture[];
  errors: EditorContextError[];
}

interface PendingEditorRequest {
  clientIds: Set<string>;
  kinds: Set<ContextKind>;
  resolve: (response: EditorContextResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class EditorContextRequestBroker {
  readonly #pending = new Map<string, PendingEditorRequest>();
  readonly #timeoutMs: number;

  constructor(timeoutMs = 5_000) {
    this.#timeoutMs = timeoutMs;
  }

  request(
    kinds: readonly ContextKind[],
    clientIds: readonly string[],
    send: (clientId: string, requestId: string, kinds: readonly ContextKind[]) => void,
  ): Promise<EditorContextResponse> {
    const uniqueKinds = [...new Set(kinds)];
    if (uniqueKinds.length === 0 || uniqueKinds.length > editorContextKinds.length) {
      return Promise.reject(new Error("capture_editor_context requires between one and four unique kinds"));
    }
    if (clientIds.length === 0) return Promise.reject(new Error("No connected VS Code client can capture editor context"));
    const requestId = Bun.randomUUIDv7();
    const { promise, resolve, reject } = Promise.withResolvers<EditorContextResponse>();
    const timeout = setTimeout(() => {
      this.#pending.delete(requestId);
      reject(new Error("Timed out waiting for VS Code editor context"));
    }, this.#timeoutMs);
    this.#pending.set(requestId, {
      clientIds: new Set(clientIds),
      kinds: new Set(uniqueKinds),
      resolve,
      reject,
      timeout,
    });
    for (const clientId of clientIds) send(clientId, requestId, uniqueKinds);
    return promise;
  }

  respond(clientId: string, requestId: string, response: EditorContextResponse): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || !pending.clientIds.has(clientId)) return false;
    const seen = new Set<ContextKind>();
    for (const capture of response.captures) {
      if (!pending.kinds.has(capture.kind) || seen.has(capture.kind)) return false;
      seen.add(capture.kind);
    }
    for (const error of response.errors) {
      if (!pending.kinds.has(error.kind) || seen.has(error.kind) || !error.error.trim()) return false;
      seen.add(error.kind);
    }
    if (seen.size !== pending.kinds.size) return false;
    this.#pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(response);
    return true;
  }

  cancelAll(reason = "Editor context request broker closed"): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}
