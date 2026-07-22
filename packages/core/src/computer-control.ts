export const computerActions = ["open_chrome", "open_system_settings", "media_play_pause"] as const;

export type ComputerAction = (typeof computerActions)[number];

export type ComputerControlResult =
  | { status: "ok"; action: ComputerAction; target: string }
  | { status: "rejected"; action: ComputerAction; code: string; explanation: string };

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ProcessRunner = (argv: readonly string[]) => Promise<ProcessResult>;

async function runProcess(argv: readonly string[]): Promise<ProcessResult> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 15_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

function failure(action: ComputerAction, result: ProcessResult, fallback: string): ComputerControlResult {
  return {
    status: "rejected",
    action,
    code: result.timedOut ? "action_timed_out" : "action_failed",
    explanation: result.timedOut ? "The macOS action timed out" : (result.stderr || fallback).slice(0, 500),
  };
}

async function isApplicationRunning(name: "Spotify" | "Music", run: ProcessRunner): Promise<boolean> {
  const result = await run(["/usr/bin/osascript", "-e", `application "${name}" is running`]);
  return result.exitCode === 0 && result.stdout.toLowerCase() === "true";
}

export async function controlMacComputer(
  action: ComputerAction,
  run: ProcessRunner = runProcess,
): Promise<ComputerControlResult> {
  if (process.platform !== "darwin") {
    return {
      status: "rejected",
      action,
      code: "unsupported_platform",
      explanation: "Computer controls are available only on macOS",
    };
  }

  switch (action) {
    case "open_chrome": {
      const result = await run(["/usr/bin/open", "-b", "com.google.Chrome"]);
      return result.exitCode === 0
        ? { status: "ok", action, target: "Google Chrome" }
        : failure(action, result, "Google Chrome could not be opened");
    }
    case "open_system_settings": {
      const result = await run(["/usr/bin/open", "x-apple.systempreferences:"]);
      return result.exitCode === 0
        ? { status: "ok", action, target: "System Settings" }
        : failure(action, result, "System Settings could not be opened");
    }
    case "media_play_pause": {
      for (const application of ["Spotify", "Music"] as const) {
        if (!(await isApplicationRunning(application, run))) continue;
        const result = await run(["/usr/bin/osascript", "-e", `tell application "${application}" to playpause`]);
        return result.exitCode === 0
          ? { status: "ok", action, target: application }
          : failure(action, result, `${application} playback could not be toggled`);
      }
      return {
        status: "rejected",
        action,
        code: "no_supported_media_app",
        explanation: "Open Spotify or Music before asking Mamachi to play or pause playback",
      };
    }
  }
}
