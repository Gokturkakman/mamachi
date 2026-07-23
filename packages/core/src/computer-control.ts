import { isAbsolute } from "node:path";

export const computerCapabilities = [
  "applications",
  "screen_observation",
  "windows",
  "keyboard",
  "pointer",
  "clipboard_read",
  "clipboard_write",
  "system",
  "apple_script",
  "shell",
] as const;

export type ComputerCapability = (typeof computerCapabilities)[number];

export const assistiveComputerCapabilities: readonly ComputerCapability[] = [
  "applications",
  "screen_observation",
  "windows",
  "keyboard",
  "pointer",
  "clipboard_write",
  "system",
];

export const fullComputerCapabilities: readonly ComputerCapability[] = [...computerCapabilities];

export const computerConfirmationModes = ["always", "sensitive", "never"] as const;
export type ComputerConfirmationMode = (typeof computerConfirmationModes)[number];

export const computerActions = [
  "open_chrome",
  "open_system_settings",
  "open_application",
  "open_url",
  "open_path",
  "activate_application",
  "hide_application",
  "quit_application",
  "list_applications",
  "frontmost_application",
  "list_windows",
  "inspect_ui",
  "media_play_pause",
  "media_next",
  "media_previous",
  "window_minimize",
  "window_maximize",
  "window_fullscreen",
  "window_close",
  "window_move_resize",
  "type_text",
  "key_press",
  "keyboard_shortcut",
  "pointer_click",
  "pointer_double_click",
  "pointer_right_click",
  "pointer_move",
  "pointer_drag",
  "pointer_scroll",
  "clipboard_read",
  "clipboard_write",
  "set_volume",
  "mute_volume",
  "unmute_volume",
  "lock_screen",
  "sleep_display",
  "sleep_system",
  "show_desktop",
  "mission_control",
  "take_screenshot",
  "run_applescript",
  "run_shell_command",
] as const;

export type ComputerAction = (typeof computerActions)[number];

export interface ComputerControlRequest {
  action: ComputerAction;
  application?: string;
  url?: string;
  path?: string;
  text?: string;
  key?: string;
  keys?: string[];
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  width?: number;
  height?: number;
  deltaX?: number;
  deltaY?: number;
  volume?: number;
  script?: string;
  command?: string;
  cwd?: string;
  timeoutSeconds?: number;
}

export type ComputerControlResult =
  | { status: "ok"; action: ComputerAction; target: string; output?: string }
  | { status: "rejected"; action: ComputerAction; code: string; explanation: string };

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type ProcessRunner = (
  argv: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export interface MacComputerControllerOptions {
  capabilities?: readonly ComputerCapability[];
  run?: ProcessRunner;
  platform?: NodeJS.Platform;
}

const actionCapabilities: Record<ComputerAction, ComputerCapability> = {
  open_chrome: "applications",
  open_system_settings: "applications",
  open_application: "applications",
  open_url: "applications",
  open_path: "applications",
  activate_application: "applications",
  hide_application: "applications",
  quit_application: "applications",
  list_applications: "screen_observation",
  frontmost_application: "screen_observation",
  list_windows: "screen_observation",
  inspect_ui: "screen_observation",
  media_play_pause: "applications",
  media_next: "applications",
  media_previous: "applications",
  window_minimize: "windows",
  window_maximize: "windows",
  window_fullscreen: "windows",
  window_close: "windows",
  window_move_resize: "windows",
  type_text: "keyboard",
  key_press: "keyboard",
  keyboard_shortcut: "keyboard",
  pointer_click: "pointer",
  pointer_double_click: "pointer",
  pointer_right_click: "pointer",
  pointer_move: "pointer",
  pointer_drag: "pointer",
  pointer_scroll: "pointer",
  clipboard_read: "clipboard_read",
  clipboard_write: "clipboard_write",
  set_volume: "system",
  mute_volume: "system",
  unmute_volume: "system",
  lock_screen: "system",
  sleep_display: "system",
  sleep_system: "system",
  show_desktop: "system",
  mission_control: "system",
  take_screenshot: "screen_observation",
  run_applescript: "apple_script",
  run_shell_command: "shell",
};

export const sensitiveComputerActions: readonly ComputerAction[] = [
  "quit_application",
  "window_close",
  "key_press",
  "keyboard_shortcut",
  "clipboard_read",
  "lock_screen",
  "sleep_system",
  "run_applescript",
  "run_shell_command",
];


const stringFields = [
  "application",
  "url",
  "path",
  "text",
  "key",
  "script",
  "command",
  "cwd",
] as const;
const numberFields = [
  "x",
  "y",
  "toX",
  "toY",
  "width",
  "height",
  "deltaX",
  "deltaY",
  "volume",
  "timeoutSeconds",
] as const;
const requestKeys = new Set<string>(["action", ...stringFields, ...numberFields, "keys"]);
const modifierNames = new Map([
  ["command", "command down"],
  ["cmd", "command down"],
  ["shift", "shift down"],
  ["option", "option down"],
  ["alt", "option down"],
  ["control", "control down"],
  ["ctrl", "control down"],
]);
const keyCodes: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  home: 115,
  end: 119,
  page_up: 116,
  page_down: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

class ComputerControlInputError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isComputerCapability(value: unknown): value is ComputerCapability {
  return typeof value === "string" && computerCapabilities.includes(value as ComputerCapability);
}

export function parseComputerControlRequest(input: unknown): ComputerControlRequest {
  if (!isObject(input)) throw new Error("control_computer arguments must be an object");
  const unexpected = Object.keys(input).find((key) => !requestKeys.has(key));
  if (unexpected) throw new Error(`control_computer does not accept ${unexpected}`);
  if (
    typeof input["action"] !== "string" ||
    !computerActions.includes(input["action"] as ComputerAction)
  ) {
    throw new Error("control_computer action is invalid");
  }
  for (const field of stringFields) {
    const value = input[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`control_computer ${field} must be a string`);
    }
  }
  for (const field of numberFields) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`control_computer ${field} must be a finite number`);
    }
  }
  if (
    input["keys"] !== undefined &&
    (!Array.isArray(input["keys"]) ||
      input["keys"].some((key) => typeof key !== "string" || key.trim().length === 0))
  ) {
    throw new Error("control_computer keys must be an array of non-empty strings");
  }
  return { ...input, action: input["action"] } as ComputerControlRequest;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes = 65_536,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let storedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (storedBytes >= maximumBytes) {
        truncated = true;
        continue;
      }
      const remaining = maximumBytes - storedBytes;
      const stored = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(stored);
      storedBytes += stored.byteLength;
      if (stored.byteLength < value.byteLength) truncated = true;
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), storedBytes)
    .toString("utf8")
    .trim();
  return truncated ? `${text}\n[output truncated]`.trim() : text;
}

async function runProcess(
  argv: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  const child = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? 20_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout),
      readBounded(child.stderr),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

function rejected(
  action: ComputerAction,
  code: string,
  explanation: string,
): ComputerControlResult {
  return { status: "rejected", action, code, explanation: explanation.slice(0, 1_000) };
}

function failure(
  action: ComputerAction,
  result: ProcessResult,
  fallback: string,
): ComputerControlResult {
  return rejected(
    action,
    result.timedOut ? "action_timed_out" : "action_failed",
    result.timedOut ? "The macOS action timed out" : result.stderr || fallback,
  );
}

function ok(
  action: ComputerAction,
  target: string,
  output?: string,
): ComputerControlResult {
  return output !== undefined
    ? { status: "ok", action, target, output: output.slice(0, 16_000) }
    : { status: "ok", action, target };
}

function requiredString(
  request: ComputerControlRequest,
  field: keyof ComputerControlRequest,
  maximumLength: number,
  preserveWhitespace = false,
): string {
  const raw = request[field];
  if (typeof raw !== "string") {
    throw new ComputerControlInputError(`${String(field)} is required for ${request.action}`);
  }
  const value = preserveWhitespace ? raw : raw.trim();
  if (!value || value.length > maximumLength) {
    throw new ComputerControlInputError(
      `${String(field)} must contain 1-${maximumLength} characters for ${request.action}`,
    );
  }
  return value;
}

function requiredNumber(
  request: ComputerControlRequest,
  field: keyof ComputerControlRequest,
  minimum: number,
  maximum: number,
): number {
  const value = request[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ComputerControlInputError(
      `${String(field)} must be between ${minimum} and ${maximum} for ${request.action}`,
    );
  }
  return Math.round(value);
}

function timeoutMs(request: ComputerControlRequest): number {
  if (request.timeoutSeconds === undefined) return 20_000;
  return requiredNumber(request, "timeoutSeconds", 1, 300) * 1_000;
}

function appleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function applicationProcess(request: ComputerControlRequest): string {
  if (!request.application) return "first application process whose frontmost is true";
  return `application process "${appleScriptString(requiredString(request, "application", 300))}"`;
}

function keyboardStatement(key: string, modifiers: readonly string[]): string {
  const normalized = key.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const modifierValues = modifiers.map((modifier) => {
    const value = modifierNames.get(modifier.trim().toLowerCase());
    if (!value) throw new ComputerControlInputError(`Unsupported modifier: ${modifier}`);
    return value;
  });
  const using = modifierValues.length > 0 ? ` using {${[...new Set(modifierValues)].join(", ")}}` : "";
  const keyCode = keyCodes[normalized];
  if (keyCode !== undefined) return `key code ${keyCode}${using}`;
  if (key.length === 1) return `keystroke "${appleScriptString(key)}"${using}`;
  throw new ComputerControlInputError(`Unsupported key: ${key}`);
}

function pointerJavaScript(request: ComputerControlRequest): string {
  const x = requiredNumber(request, "x", -100_000, 100_000);
  const y = requiredNumber(request, "y", -100_000, 100_000);
  const point = `$.CGPointMake(${x}, ${y})`;
  const prelude = 'ObjC.import("CoreGraphics");';
  const post = (eventType: string, button: string, at: string) =>
    `e=$.CGEventCreateMouseEvent(null, $.${eventType}, ${at}, $.${button}); $.CGEventPost($.kCGHIDEventTap, e);`;
  switch (request.action) {
    case "pointer_move":
      return `${prelude} ${post("kCGEventMouseMoved", "kCGMouseButtonLeft", point)}`;
    case "pointer_click":
      return `${prelude} ${post("kCGEventLeftMouseDown", "kCGMouseButtonLeft", point)} delay(0.04); ${post("kCGEventLeftMouseUp", "kCGMouseButtonLeft", point)}`;
    case "pointer_double_click":
      return [
        prelude,
        `p=${point};`,
        "d=$.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft);",
        "$.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, 2);",
        "$.CGEventPost($.kCGHIDEventTap, d);",
        "u=$.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft);",
        "$.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, 2);",
        "$.CGEventPost($.kCGHIDEventTap, u); delay(0.08); $.CGEventPost($.kCGHIDEventTap, d); $.CGEventPost($.kCGHIDEventTap, u);",
      ].join(" ");
    case "pointer_right_click":
      return `${prelude} ${post("kCGEventRightMouseDown", "kCGMouseButtonRight", point)} delay(0.04); ${post("kCGEventRightMouseUp", "kCGMouseButtonRight", point)}`;
    case "pointer_drag": {
      const toX = requiredNumber(request, "toX", -100_000, 100_000);
      const toY = requiredNumber(request, "toY", -100_000, 100_000);
      const destination = `$.CGPointMake(${toX}, ${toY})`;
      return `${prelude} ${post("kCGEventLeftMouseDown", "kCGMouseButtonLeft", point)} delay(0.08); ${post("kCGEventLeftMouseDragged", "kCGMouseButtonLeft", destination)} delay(0.08); ${post("kCGEventLeftMouseUp", "kCGMouseButtonLeft", destination)}`;
    }
    default:
      throw new ComputerControlInputError(`Unsupported pointer action: ${request.action}`);
  }
}

async function firstRunningMediaApplication(run: ProcessRunner): Promise<"Spotify" | "Music" | null> {
  for (const application of ["Spotify", "Music"] as const) {
    const result = await run([
      "/usr/bin/osascript",
      "-e",
      `application "${application}" is running`,
    ]);
    if (result.exitCode === 0 && result.stdout.toLowerCase() === "true") return application;
  }
  return null;
}

export class MacComputerController {
  readonly #run: ProcessRunner;
  readonly #platform: NodeJS.Platform;
  #capabilities: Set<ComputerCapability>;

  constructor(options: MacComputerControllerOptions = {}) {
    this.#run = options.run ?? runProcess;
    this.#platform = options.platform ?? process.platform;
    this.#capabilities = new Set(options.capabilities ?? assistiveComputerCapabilities);
  }

  configure(capabilities: readonly ComputerCapability[]): void {
    this.#capabilities = new Set(capabilities);
  }

  capabilities(): ComputerCapability[] {
    return computerCapabilities.filter((capability) => this.#capabilities.has(capability));
  }

  async control(request: ComputerControlRequest): Promise<ComputerControlResult> {
    const action = request.action;
    const capability = actionCapabilities[action];
    if (!this.#capabilities.has(capability)) {
      return rejected(
        action,
        "capability_disabled",
        `${capability} computer access is disabled in Mamachi Settings`,
      );
    }
    if (this.#platform !== "darwin") {
      return rejected(action, "unsupported_platform", "Computer controls are available only on macOS");
    }

    try {
      return await this.#execute(request);
    } catch (error) {
      if (error instanceof ComputerControlInputError) {
        return rejected(action, "invalid_arguments", error.message);
      }
      return rejected(
        action,
        "action_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #execute(request: ComputerControlRequest): Promise<ComputerControlResult> {
    const { action } = request;
    switch (action) {
      case "open_chrome":
        return this.#process(action, ["/usr/bin/open", "-b", "com.google.Chrome"], "Google Chrome");
      case "open_system_settings":
        return this.#process(action, ["/usr/bin/open", "x-apple.systempreferences:"], "System Settings");
      case "open_application": {
        const application = requiredString(request, "application", 300);
        return this.#process(action, ["/usr/bin/open", "-a", application], application);
      }
      case "open_url": {
        const url = requiredString(request, "url", 4_096);
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
          throw new ComputerControlInputError("url must include a URI scheme");
        }
        return this.#process(action, ["/usr/bin/open", url], url);
      }
      case "open_path": {
        const path = requiredString(request, "path", 4_096);
        return this.#process(action, ["/usr/bin/open", path], path);
      }
      case "activate_application":
      case "quit_application": {
        const application = requiredString(request, "application", 300);
        const verb = action === "activate_application" ? "activate" : "quit";
        return this.#appleScript(
          action,
          `tell application "${appleScriptString(application)}" to ${verb}`,
          application,
        );
      }
      case "hide_application": {
        const application = requiredString(request, "application", 300);
        return this.#appleScript(
          action,
          `tell application "System Events" to set visible of application process "${appleScriptString(application)}" to false`,
          application,
        );
      }
      case "list_applications":
        return this.#appleScript(
          action,
          'tell application "System Events" to get name of every application process whose background only is false',
          "running applications",
          true,
        );
      case "frontmost_application":
        return this.#appleScript(
          action,
          'tell application "System Events" to get name of first application process whose frontmost is true',
          "frontmost application",
          true,
        );
      case "list_windows":
        return this.#appleScript(
          action,
          `tell application "System Events" to tell ${applicationProcess(request)} to get {name, position, size} of every window`,
          request.application ?? "frontmost application windows",
          true,
        );
      case "inspect_ui":
        return this.#appleScript(
          action,
          `tell application "System Events" to tell ${applicationProcess(request)} to get entire contents of front window`,
          request.application ?? "frontmost application UI",
          true,
          30_000,
        );
      case "media_play_pause":
      case "media_next":
      case "media_previous": {
        const application = await firstRunningMediaApplication(this.#run);
        if (!application) {
          return rejected(
            action,
            "no_supported_media_app",
            "Open Spotify or Music before controlling playback",
          );
        }
        const command =
          action === "media_play_pause"
            ? "playpause"
            : action === "media_next"
              ? "next track"
              : "previous track";
        return this.#appleScript(
          action,
          `tell application "${application}" to ${command}`,
          application,
        );
      }
      case "window_minimize":
      case "window_maximize":
      case "window_fullscreen":
      case "window_close":
      case "window_move_resize": {
        const process = applicationProcess(request);
        let statement: string;
        if (action === "window_minimize") {
          statement = 'set value of attribute "AXMinimized" of front window to true';
        } else if (action === "window_maximize") {
          statement = 'perform action "AXZoomWindow" of front window';
        } else if (action === "window_fullscreen") {
          statement = 'set frontmost to true\nkeystroke "f" using {command down, control down}';
        } else if (action === "window_close") {
          statement = 'perform action "AXClose" of front window';
        } else {
          const x = requiredNumber(request, "x", -100_000, 100_000);
          const y = requiredNumber(request, "y", -100_000, 100_000);
          const width = requiredNumber(request, "width", 100, 100_000);
          const height = requiredNumber(request, "height", 100, 100_000);
          statement = `set position of front window to {${x}, ${y}}\nset size of front window to {${width}, ${height}}`;
        }
        return this.#appleScript(
          action,
          `tell application "System Events"\nset targetProcess to ${process}\ntell targetProcess\n${statement}\nend tell\nend tell`,
          request.application ?? "frontmost window",
        );
      }
      case "type_text": {
        const text = requiredString(request, "text", 20_000, true);
        return this.#appleScript(
          action,
          `tell application "System Events" to keystroke "${appleScriptString(text)}"`,
          "keyboard",
        );
      }
      case "key_press": {
        const key = requiredString(request, "key", 100);
        const modifiers = request.keys ?? [];
        return this.#appleScript(
          action,
          `tell application "System Events" to ${keyboardStatement(key, modifiers)}`,
          "keyboard",
        );
      }
      case "keyboard_shortcut": {
        const keys = request.keys;
        if (!keys || keys.length < 1 || keys.length > 5) {
          throw new ComputerControlInputError("keys must contain one key and up to four modifiers");
        }
        const primary = keys.filter((key) => !modifierNames.has(key.trim().toLowerCase()));
        const modifiers = keys.filter((key) => modifierNames.has(key.trim().toLowerCase()));
        if (primary.length !== 1) {
          throw new ComputerControlInputError("keys must contain exactly one non-modifier key");
        }
        return this.#appleScript(
          action,
          `tell application "System Events" to ${keyboardStatement(primary[0]!, modifiers)}`,
          "keyboard",
        );
      }
      case "pointer_click":
      case "pointer_double_click":
      case "pointer_right_click":
      case "pointer_move":
      case "pointer_drag":
        return this.#process(
          action,
          ["/usr/bin/osascript", "-l", "JavaScript", "-e", pointerJavaScript(request)],
          "pointer",
        );
      case "pointer_scroll": {
        const deltaX = requiredNumber(request, "deltaX", -10_000, 10_000);
        const deltaY = requiredNumber(request, "deltaY", -10_000, 10_000);
        const script = [
          'ObjC.import("CoreGraphics");',
          `e=$.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, ${deltaY}, ${deltaX});`,
          "$.CGEventPost($.kCGHIDEventTap, e);",
        ].join(" ");
        return this.#process(
          action,
          ["/usr/bin/osascript", "-l", "JavaScript", "-e", script],
          "pointer",
        );
      }
      case "clipboard_read":
        return this.#process(action, ["/usr/bin/pbpaste"], "clipboard", true);
      case "clipboard_write": {
        const text = requiredString(request, "text", 100_000, true);
        return this.#appleScript(
          action,
          `set the clipboard to "${appleScriptString(text)}"`,
          "clipboard",
        );
      }
      case "set_volume": {
        const volume = requiredNumber(request, "volume", 0, 100);
        return this.#appleScript(action, `set volume output volume ${volume}`, `volume ${volume}%`);
      }
      case "mute_volume":
      case "unmute_volume":
        return this.#appleScript(
          action,
          `set volume output muted ${action === "mute_volume" ? "true" : "false"}`,
          "system volume",
        );
      case "lock_screen":
        return this.#process(
          action,
          ["/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", "-suspend"],
          "lock screen",
        );
      case "sleep_display":
      case "sleep_system":
        return this.#process(
          action,
          ["/usr/bin/pmset", action === "sleep_display" ? "displaysleepnow" : "sleepnow"],
          action === "sleep_display" ? "display" : "computer",
        );
      case "show_desktop":
      case "mission_control":
        return this.#appleScript(
          action,
          `tell application "System Events" to key code ${action === "show_desktop" ? 103 : 160}`,
          action === "show_desktop" ? "desktop" : "Mission Control",
        );
      case "take_screenshot": {
        const path = request.path?.trim() || `/tmp/mamachi-screen-${Date.now()}.png`;
        if (!isAbsolute(path) || path.length > 4_096) {
          throw new ComputerControlInputError("path must be an absolute path of at most 4096 characters");
        }
        return this.#process(action, ["/usr/sbin/screencapture", "-x", path], path);
      }
      case "run_applescript": {
        const script = requiredString(request, "script", 50_000, true);
        return this.#appleScript(action, script, "AppleScript", true, timeoutMs(request));
      }
      case "run_shell_command": {
        const command = requiredString(request, "command", 100_000, true);
        const cwd = request.cwd?.trim();
        if (cwd && (!isAbsolute(cwd) || cwd.length > 4_096)) {
          throw new ComputerControlInputError("cwd must be an absolute path of at most 4096 characters");
        }
        return this.#process(
          action,
          ["/bin/zsh", "-lc", command],
          "shell",
          true,
          { ...(cwd ? { cwd } : {}), timeoutMs: timeoutMs(request) },
        );
      }
    }
  }

  async #appleScript(
    action: ComputerAction,
    source: string,
    target: string,
    includeOutput = false,
    timeout = 20_000,
  ): Promise<ComputerControlResult> {
    return this.#process(
      action,
      ["/usr/bin/osascript", "-e", source],
      target,
      includeOutput,
      { timeoutMs: timeout },
    );
  }

  async #process(
    action: ComputerAction,
    argv: readonly string[],
    target: string,
    includeOutput = false,
    options?: ProcessRunOptions,
  ): Promise<ComputerControlResult> {
    const result = await this.#run(argv, options);
    if (result.exitCode !== 0 || result.timedOut) {
      return failure(action, result, `${target} could not be controlled`);
    }
    return ok(action, target, includeOutput ? result.stdout : undefined);
  }
}

export async function controlMacComputer(
  request: ComputerControlRequest,
  options: MacComputerControllerOptions = {},
): Promise<ComputerControlResult> {
  return new MacComputerController(options).control(request);
}
