import { describe, expect, test } from "bun:test";
import { controlMacComputer, type ProcessResult, type ProcessRunner } from "../src/computer-control.ts";

function successful(stdout = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

describe("controlMacComputer", () => {
  test("opens only the fixed Chrome and System Settings targets", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push([...argv]);
      return successful();
    };

    await expect(controlMacComputer("open_chrome", run)).resolves.toEqual({
      status: "ok",
      action: "open_chrome",
      target: "Google Chrome",
    });
    await expect(controlMacComputer("open_system_settings", run)).resolves.toEqual({
      status: "ok",
      action: "open_system_settings",
      target: "System Settings",
    });
    expect(calls).toEqual([
      ["/usr/bin/open", "-b", "com.google.Chrome"],
      ["/usr/bin/open", "x-apple.systempreferences:"],
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

    await expect(controlMacComputer("media_play_pause", run)).resolves.toEqual({
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

  test("rejects playback control when no supported media app is running", async () => {
    const run: ProcessRunner = async () => successful("false");

    await expect(controlMacComputer("media_play_pause", run)).resolves.toEqual({
      status: "rejected",
      action: "media_play_pause",
      code: "no_supported_media_app",
      explanation: "Open Spotify or Music before asking Mamachi to play or pause playback",
    });
  });
});
