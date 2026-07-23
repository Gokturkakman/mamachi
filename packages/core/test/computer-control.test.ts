import { describe, expect, test } from "bun:test";
import {
  controlMacComputer,
  parseComputerControlRequest,
} from "../src/computer-control.ts";
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
} from "../src/computer-control.ts";

function successful(stdout = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

describe("controlMacComputer", () => {
  test("opens legacy and arbitrary application targets without invoking a shell", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return successful();
    };
    const options = {
      capabilities: ["applications"] as const,
      platform: "darwin" as const,
      run,
    };

    await expect(controlMacComputer({ action: "open_chrome" }, options)).resolves.toEqual({
      status: "ok",
      action: "open_chrome",
      target: "Google Chrome",
    });
    await expect(
      controlMacComputer(
        { action: "open_application", application: 'Safari"; do shell script "touch /tmp/bad' },
        options,
      ),
    ).resolves.toMatchObject({ status: "ok", action: "open_application" });
    expect(calls).toEqual([
      ["/usr/bin/open", "-b", "com.google.Chrome"],
      ["/usr/bin/open", "-a", 'Safari"; do shell script "touch /tmp/bad'],
    ]);
  });

  test("toggles the first running supported media app", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      const command = argv.join(" ");
      if (command.includes('application "Spotify" is running')) return successful("false");
      if (command.includes('application "Music" is running')) return successful("true");
      return successful();
    };

    await expect(
      controlMacComputer(
        { action: "media_play_pause" },
        { capabilities: ["applications"], platform: "darwin", run },
      ),
    ).resolves.toEqual({
      status: "ok",
      action: "media_play_pause",
      target: "Music",
    });
    expect(calls).toEqual([
      ["/usr/bin/osascript", "-e", 'application "Spotify" is running'],
      ["/usr/bin/osascript", "-e", 'application "Music" is running'],
      ["/usr/bin/osascript", "-e", 'tell application "Music" to playpause'],
    ]);
  });

  test("blocks disabled capabilities before launching a process", async () => {
    let called = false;
    const run: ProcessRunner = async () => {
      called = true;
      return successful();
    };

    await expect(
      controlMacComputer(
        { action: "run_shell_command", command: "echo should-not-run" },
        { capabilities: ["applications"], platform: "darwin", run },
      ),
    ).resolves.toEqual({
      status: "rejected",
      action: "run_shell_command",
      code: "capability_disabled",
      explanation: "shell computer access is disabled in Mamachi Settings",
    });
    expect(called).toBe(false);
  });

  test("runs raw shell commands only through the explicit shell capability", async () => {
    const calls: Array<{ argv: string[]; options: ProcessRunOptions | undefined }> = [];
    const run: ProcessRunner = async (argv, options) => {
      calls.push({ argv: [...argv], options });
      return successful("done");
    };

    await expect(
      controlMacComputer(
        {
          action: "run_shell_command",
          command: "printf done",
          cwd: "/tmp",
          timeoutSeconds: 7,
        },
        { capabilities: ["shell"], platform: "darwin", run },
      ),
    ).resolves.toEqual({
      status: "ok",
      action: "run_shell_command",
      target: "shell",
      output: "done",
    });
    expect(calls).toEqual([{
      argv: ["/bin/zsh", "-lc", "printf done"],
      options: { cwd: "/tmp", timeoutMs: 7_000 },
    }]);
  });

  test("builds bounded keyboard shortcuts and rejects malformed tool payloads", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return successful();
    };

    await expect(
      controlMacComputer(
        { action: "keyboard_shortcut", keys: ["command", "shift", "p"] },
        { capabilities: ["keyboard"], platform: "darwin", run },
      ),
    ).resolves.toMatchObject({ status: "ok", action: "keyboard_shortcut" });
    expect(calls[0]?.[2]).toBe(
      'tell application "System Events" to keystroke "p" using {command down, shift down}',
    );
    expect(() =>
      parseComputerControlRequest({ action: "pointer_click", x: 1, y: 2, surprise: true })
    ).toThrow("does not accept surprise");
  });
});
