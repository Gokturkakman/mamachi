import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface EditorDocumentState {
  workspace: string;
  path: string;
  version: number;
  dirty: boolean;
  open: boolean;
}

export interface WorkspaceConflict {
  paths: string[];
  reason: string;
  externalChanges: string[];
  dirtyFiles: string[];
}

export type WorkspaceGuardDecision =
  | { status: "allowed" }
  | { status: "conflict"; conflict: WorkspaceConflict };

export interface WorkspaceMutation {
  toolCallId: string;
  toolName: string;
  paths: string[];
  recordedAt: string;
}

interface MutationScope {
  targets: string[];
  mayMutateUnknownFiles: boolean;
  replacesWholeFile: boolean;
  canMutate: boolean;
}

interface ToolBaseline {
  toolName: string;
  scope: MutationScope;
  files: Map<string, string>;
  editorVersions: Map<string, number>;
}
export function extractToolPaths(input: unknown): string[] {
  const details =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const paths = [
    ...(typeof details["path"] === "string" ? [details["path"]] : []),
    ...(typeof details["file"] === "string" ? [details["file"]] : []),
    ...(typeof details["new_name"] === "string" ? [details["new_name"]] : []),
    ...(Array.isArray(details["paths"])
      ? details["paths"].filter((path): path is string => typeof path === "string")
      : []),
  ];
  for (const value of [details["patch"], details["input"]]) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(/^\[([^#\]\r\n]+)#[0-9A-Fa-f]{4}\]$/gm)) {
      if (match[1]) paths.push(match[1]);
    }
    for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      if (match[1]) paths.push(match[1]);
    }
  }
  return paths.filter((path, index) => path.length > 0 && paths.indexOf(path) === index);
}


const shellMutationPattern =
  /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|rmdir|touch|truncate|tee|install|patch|git\s+(?:checkout|switch|reset|restore|clean|apply))\b|(?:^|[^>])>(?!>)/i;

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

export class WorkspaceGuard {
  #taskId: string | null = null;
  #runId: string | null = null;
  #repository: string | null = null;
  #knownFiles = new Map<string, string>();
  #preExistingChanges = new Set<string>();
  #externalChanges = new Set<string>();
  #editorStates = new Map<string, EditorDocumentState>();
  #reportedEditorStates = new Map<string, EditorDocumentState>();
  #toolBaselines = new Map<string, ToolBaseline>();
  #pendingAttribution: Promise<WorkspaceConflict | null> = Promise.resolve(null);
  readonly #mutations: WorkspaceMutation[] = [];

  async start(taskId: string, runId: string, repository: string): Promise<void> {
    this.#taskId = taskId;
    this.#runId = runId;
    this.#repository = resolve(repository);
    this.#editorStates.clear();
    for (const state of this.#reportedEditorStates.values()) {
      if (resolve(state.workspace) !== this.#repository) continue;
      const path = this.#relativePath(state.path);
      if (path) this.#editorStates.set(path, { ...state, path });
    }
    this.#knownFiles = await this.#scanFiles();
    this.#preExistingChanges = await this.#readPreExistingChanges();
    this.#externalChanges.clear();
    this.#toolBaselines.clear();
    this.#mutations.length = 0;
    this.#pendingAttribution = Promise.resolve(null);
  }

  updateEditorState(state: EditorDocumentState): void {
    const workspace = resolve(state.workspace);
    const absolutePath = resolve(workspace, state.path);
    const reported = { ...state, workspace, path: absolutePath };
    if (state.open) this.#reportedEditorStates.set(absolutePath, reported);
    else this.#reportedEditorStates.delete(absolutePath);
    if (!this.#repository || workspace !== this.#repository) return;
    const path = this.#relativePath(absolutePath);
    if (!path) return;
    const previous = this.#editorStates.get(path);
    if (state.open) this.#editorStates.set(path, { ...reported, path });
    else this.#editorStates.delete(path);
    if (!this.#taskId) return;
    if (state.dirty || (previous?.dirty === true && state.dirty === false)) {
      this.#externalChanges.add(path);
    }
  }

  async beforeTool(toolCallId: string, toolName: string, input: unknown): Promise<WorkspaceGuardDecision> {
    const pendingConflict = await this.#pendingAttribution;
    if (pendingConflict) return { status: "conflict", conflict: pendingConflict };
    if (!this.#repository || !this.#taskId || !this.#runId) return { status: "allowed" };

    const currentFiles = await this.#scanFiles();
    for (const path of changedPaths(this.#knownFiles, currentFiles)) this.#externalChanges.add(path);
    const scope = this.#mutationScope(toolName, input);
    if (!scope.canMutate) {
      if (scope.mayMutateUnknownFiles) {
        this.#toolBaselines.set(toolCallId, {
          toolName,
          scope,
          files: currentFiles,
          editorVersions: new Map([...this.#editorStates].map(([path, editor]) => [path, editor.version])),
        });
      }
      return { status: "allowed" };
    }
    const dirtyFiles = [...this.#editorStates.entries()]
      .filter(([, state]) => state.dirty)
      .map(([path]) => path);
    const candidates = scope.mayMutateUnknownFiles
      ? new Set([...this.#externalChanges, ...dirtyFiles, ...this.#preExistingChanges])
      : new Set(scope.targets);
    const overlaps = [...candidates].filter((path) => {
      if (scope.mayMutateUnknownFiles) return true;
      if (dirtyFiles.includes(path) || this.#externalChanges.has(path)) return true;
      return scope.replacesWholeFile && this.#preExistingChanges.has(path);
    });
    if (overlaps.length > 0) {
      return {
        status: "conflict",
        conflict: {
          paths: overlaps.sort(),
          reason: scope.mayMutateUnknownFiles
            ? "A broad mutating command may overlap user changes"
            : "The coding agent is about to overwrite a file changed by the user",
          externalChanges: [...this.#externalChanges].sort(),
          dirtyFiles: dirtyFiles.sort(),
        },
      };
    }

    this.#toolBaselines.set(toolCallId, {
      toolName,
      scope,
      files: currentFiles,
      editorVersions: new Map([...this.#editorStates].map(([path, editor]) => [path, editor.version])),
    });
    return { status: "allowed" };
  }

  afterTool(toolCallId: string): Promise<WorkspaceConflict | null> {
    const operation = this.#attributeTool(toolCallId);
    this.#pendingAttribution = operation;
    return operation;
  }

  async reconcile(): Promise<string[]> {
    await this.#pendingAttribution;
    const current = await this.#scanFiles();
    const accepted = [...new Set([...this.#externalChanges, ...changedPaths(this.#knownFiles, current)])].sort();
    this.#pendingAttribution = Promise.resolve(null);
    this.#knownFiles = current;
    this.#externalChanges.clear();
    this.#toolBaselines.clear();
    return accepted;
  }

  mutations(): WorkspaceMutation[] {
    return this.#mutations.map((mutation) => ({ ...mutation, paths: [...mutation.paths] }));
  }

  finish(): void {
    this.#taskId = null;
    this.#runId = null;
    this.#repository = null;
    this.#knownFiles.clear();
    this.#preExistingChanges.clear();
    this.#externalChanges.clear();
    this.#toolBaselines.clear();
    this.#mutations.length = 0;
    this.#editorStates.clear();
  }

  async #attributeTool(toolCallId: string): Promise<WorkspaceConflict | null> {
    const baseline = this.#toolBaselines.get(toolCallId);
    this.#toolBaselines.delete(toolCallId);
    if (!baseline || !this.#repository) return null;
    const currentFiles = await this.#scanFiles();
    const changed = changedPaths(baseline.files, currentFiles);
    const concurrentEditorChanges = [...this.#editorStates.entries()]
      .filter(([path, state]) => {
        const relevant = baseline.scope.mayMutateUnknownFiles || baseline.scope.targets.includes(path);
        return relevant && baseline.editorVersions.get(path) !== state.version;
      })
      .map(([path]) => path);
    const attributed = changed.filter((path) => !concurrentEditorChanges.includes(path));
    for (const path of attributed) this.#externalChanges.delete(path);
    this.#knownFiles = currentFiles;
    if (attributed.length > 0) {
      this.#mutations.push({
        toolCallId,
        toolName: baseline.toolName,
        paths: attributed,
        recordedAt: new Date().toISOString(),
      });
    }
    if (concurrentEditorChanges.length === 0) return null;
    for (const path of concurrentEditorChanges) this.#externalChanges.add(path);
    return {
      paths: concurrentEditorChanges.sort(),
      reason: "The user edited a target while the coding tool was running",
      externalChanges: [...this.#externalChanges].sort(),
      dirtyFiles: [...this.#editorStates.entries()]
        .filter(([, state]) => state.dirty)
        .map(([path]) => path)
        .sort(),
    };
  }

  #mutationScope(toolName: string, input: unknown): MutationScope {
    const details =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const targets = extractToolPaths(input)
      .flatMap((path) => {
        const normalized = this.#relativePath(path);
        return normalized ? [normalized] : [];
      })
      .filter((path, index, paths) => paths.indexOf(path) === index);
    const lspMutation =
      toolName === "lsp" &&
      details["apply"] === true &&
      ["rename", "rename_file", "code_actions"].includes(String(details["action"]));
    const command = typeof details["command"] === "string" ? details["command"] : "";
    const shellMutates = toolName === "bash" && shellMutationPattern.test(command);
    return {
      targets,
      canMutate: ["edit", "write", "ast_edit"].includes(toolName) || lspMutation || shellMutates,
      mayMutateUnknownFiles: toolName === "bash",
      replacesWholeFile: toolName === "write" || (lspMutation && String(details["action"]) === "rename_file"),
    };
  }

  #relativePath(path: string): string | null {
    if (!this.#repository) return null;
    const absolute = resolve(this.#repository, path);
    const candidate = relative(this.#repository, absolute);
    if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
      return null;
    }
    return candidate;
  }

  async #scanFiles(): Promise<Map<string, string>> {
    if (!this.#repository) return new Map();
    const paths = await this.#workspaceFiles();
    const fingerprints = new Map<string, string>();
    for (let offset = 0; offset < paths.length; offset += 24) {
      const batch = paths.slice(offset, offset + 24);
      const entries = await Promise.all(batch.map(async (path): Promise<[string, string] | null> => {
        const absolute = resolve(this.#repository ?? "", path);
        try {
          const stats = await lstat(absolute);
          if (stats.isSymbolicLink()) {
            return [path, `link:${await readlink(absolute)}`];
          }
          if (!stats.isFile()) return null;
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(absolute)) hash.update(chunk);
          return [path, `${stats.mode}:${stats.size}:${hash.digest("hex")}`];
        } catch {
          return null;
        }
      }));
      for (const entry of entries) if (entry) fingerprints.set(entry[0], entry[1]);
    }
    return fingerprints;
  }

  async #workspaceFiles(): Promise<string[]> {
    if (!this.#repository) return [];
    const git = Bun.spawn(["git", "-C", this.#repository, "ls-files", "-co", "--exclude-standard", "-z"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(git.stdout).arrayBuffer();
    if ((await git.exited) === 0) {
      return Buffer.from(output)
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .sort();
    }
    const paths: string[] = [];
    const glob = new Bun.Glob("**/*");
    for await (const path of glob.scan({ cwd: this.#repository, dot: true, onlyFiles: true })) {
      if (path === ".git" || path.startsWith(".git/") || path === "node_modules" || path.startsWith("node_modules/")) continue;
      paths.push(path);
    }
    return paths.sort();
  }

  async #readPreExistingChanges(): Promise<Set<string>> {
    if (!this.#repository) return new Set();
    const git = Bun.spawn(
      ["git", "-C", this.#repository, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(git.stdout).arrayBuffer();
    if ((await git.exited) !== 0) return new Set();
    const entries = Buffer.from(output).toString("utf8").split("\0").filter(Boolean);
    const paths = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] ?? "";
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (path) paths.add(path);
      if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
        paths.add(entries[index + 1] as string);
        index += 1;
      }
    }
    return paths;
  }
}
