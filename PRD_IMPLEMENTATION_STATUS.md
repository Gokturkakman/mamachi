# Mamachi PRD Implementation Status

**Updated:** 2026-07-23  
**Compared against:** `PRD.md`  
**Current stage:** Invited-alpha implementation candidate; release signing plus clean-machine voice, permission, and hardware validation remain external gates.

## Bottom line

The integrated product loop is implemented:

> Voice or text request → risk-aware dispatch → durable queued task → selected OMP, Codex, or Claude coding session → evidence-gated completion → spoken/visual brief and inspectable artifacts

The implementation is local-first and keeps one mutating coding job active at a time. Voice conversation, status requests, safe steering, and unrelated queued work remain available while coding runs.

## Implemented

### Protocol, controller, and persistence

- Strict shared JSON Schemas for commands, events, task specifications, revisions, questions, confirmations, runs, artifacts, and queue operations.
- Generated Swift and VS Code protocol bindings checked against the canonical schema.
- UUIDv7 command/event identities, idempotent command replay, optimistic revisions, and revision-bound single-use confirmations.
- Durable SQLite event log, task queue, run/session identity, exact coder questions, task-spec revision history, scoped memories, observer interpretations, evidence, and sleep briefs.
- Versioned, idempotent migrations from the prototype schema.
- Sequence-based IPC replay with reset-to-snapshot behavior for stale clients.
- AES-256-GCM protection for command/event payloads, task context, captured editor payloads, evidence, observer notes, explicit memories, queued briefs, and native transcript files. Legacy plaintext sensitive fields migrate when the application key becomes available.

### Coding-agent backends

- OMP `17.0.7` remains embedded through `createAgentSession()` with direct `steer()`, `followUp()`, abort, coder-question, and final-summary integration.
- Codex CLI and Claude Code run non-interactively through their structured JSON streams using the user’s existing subscription login and native configuration.
- Backend choice is explicit and persisted in runtime settings; Mamachi never silently falls back to a different agent or account.
- Backend-qualified session IDs are persisted and resumed in the original repository after accepted pauses and restart recovery.
- User-selectable primary/fast model selectors, thinking level, and automatic routing remain available; provider-qualified model names map only to matching direct CLIs.
- Structured tool and external-turn events normalize into task/run evidence. Completion requires persisted successful evidence; file changes require later successful verification.
- OMP reuses discovered provider auth storage. Explicit provider keys remain optional for coding and are passed only to the selected adapter.
- Provider keys, the encryption key, and daemon IPC token are removed from the general tool process environment.

### Policy, attribution, and observation

- Harness-side risk policy for routine work, visual approval, and hard rejection.
- Destructive system-wide commands and credential-access attempts are rejected.
- Publication, deployment, purchase, destructive repository operations, and out-of-repository effects require exact visual approval.
- Embedded OMP tool interception occurs before execution; direct CLIs retain their native sandbox/permission enforcement and are stopped at supervised process boundaries.
- Workspace guard records baselines, protects dirty/pre-existing user work, detects OMP tool edits and external-CLI turn changes, pauses on conflicts, and records explicit reconciliation before resume.
- Focused-editor paths are canonicalized across macOS symlink aliases.
- Deterministic fact projection separates implementation, verification, blocker, decision, file, and progress state.
- A read-only passive OMP observer receives bounded projected facts, cannot call tools, and cannot mutate controller state.

### Realtime voice bridge

- OpenAI Realtime WebSocket adapter with duplex 24 kHz PCM, text mode, server VAD, interruption, provider-history truncation using exact played-audio metadata, bounded reconnect, and response/tool-chain state.
- The provider connection remains open while the microphone sleeps.
- Completion, failure, and attention briefs queue durably while sleeping and are delivered only after re-engagement.
- Realtime failures do not stop coding; coding failures do not terminate the voice session.
- Complete strict tool surface from PRD section 16, including workspace/profile discovery, explicit editor capture, task submission/status/artifacts, exact coder answers, safe task changes, queue control, memories, configurable computer control, overlay control, and microphone sleep.
- Consequential changes pause at a safe boundary, persist a revised specification, and resume; low-risk clarifications use direct steering.
- Casual conversation is not durable memory. Only confirmed task facts and explicit remember/forget actions persist.

### macOS product surface

- Menu-bar lifecycle, Wispr-style wake gestures on a configurable bare modifier (double-tap Fn for hands-free, hold for push-to-talk, tap again to barge in or sleep) that survive terminal Secure Keyboard Entry, the global `⌥Space` hotkey as a fallback needing no Accessibility trust, explicit Open/Hide/Quit controls, and live idle/working/attention status.
- Exact-size 116×28 non-activating collapsed pill with a live microphone waveform while listening, a playout-timed speech waveform while the assistant talks, shimmer/pulse thinking and connecting states, concise status text while dormant, whole-surface drag/open behavior, right-click recovery controls, and expandable Task/Chat surface.
- Expanded Task/Chat drawer with live transcript, composer, current objective/step, queue, confirmations, coder questions, revision history, changed files, evidence, verification, and controls.
- Animated collapse/expand morph from the shared bottom-center anchor (easeOut frame animation with synchronized content crossfade), sub-150 ms wake acknowledgment pop, and reduce-motion fallbacks throughout.
- Accessibility-gated wake-key monitoring with live status in Settings, plus Globe-key conflict detection (emoji, input-source, and dictation bindings) with keyboard-settings deep links in Settings and onboarding.
- Native notifications and optional reaction sounds for attention/completion.
- Repository picker plus focused VS Code workspace handoff.
- First-run onboarding requires a working coding agent, detects existing OMP/Codex/Claude logins, and offers one-click terminal installation/login. An OMP API key is an optional fallback, not a duplicate requirement.
- OpenAI Realtime and optional coding credentials plus the application encryption key are stored in macOS Keychain; coding subscription tokens remain owned by their CLIs.
- Local builds automatically use an available persistent Developer ID or Apple Development identity, preventing rebuilt binaries from repeatedly invalidating Keychain authorization. Explicit ad-hoc builds remain available with a warning.
- Preview-before-export diagnostics with an allowlisted, bounded schema that excludes source, transcripts, prompts, tool arguments, credentials, and audio.
- Privacy controls for transcript retention, credential replacement/removal, diagnostics preview/export, and overlay reset.
- Computer control can launch arbitrary applications with common aliases and perform structured accessibility inspection, named clicks, value entry, and menu selection; the voice prompt requires minimal multi-step action chains and visible-result verification.

### VS Code integration and distribution

- Authenticated reconnecting client with deterministic snapshot-plus-sequence replay and bounded backoff.
- Focused workspace and editor dirty/version state reporting without background document content.
- Explicit active-file, selection, diagnostics, and terminal-excerpt capture. Selection and terminal content require user action.
- Generated protocol types/constants are consumed by both clients.
- The standalone macOS bundle embeds the compiled daemon and the compiled VS Code extension.
- Onboarding can install the bundled extension into the user’s VS Code extension directory.
- Packaging automatically selects a persistent local signing identity when available, supports explicit ad-hoc or Developer ID modes, applies the required Bun daemon entitlements under hardened runtime, and provides optional notarization preflight, submission, and stapling.

## Verification

- `bun run typecheck`: passed.
- `bun test`: 92 passed, 0 failed across protocol, core, backend-runner, computer-control, and VS Code tests.
- `apps/vscode`: typecheck and production bundle passed as part of the workspace checks/build.
- `cd apps/macos && swift test`: 39 passed, 0 failed, including the wake-gesture recognizer (double-tap, hold, combo poisoning, engagement mapping), audio-level history, rapid overlay transitions, anchor invariants, OMP-login parsing, snapshots, audio, privacy, and encryption.
- `apps/macos/build-app.sh`: produced `apps/macos/dist/Mamachi.app` with the embedded daemon and VS Code extension.
- `codesign --verify --deep --strict --verbose=2 apps/macos/dist/Mamachi.app`: valid on disk and satisfies its designated requirement.
- Live backend smokes: Codex completed a supervised repository task and OMP completed an authenticated provider turn. Claude’s authenticated CLI emitted the expected structured session protocol, then the local account rejected model work for insufficient credit; deterministic Claude stream/resume coverage passes.
- Native UI smoke: onboarding detected the existing Codex login and completed without a coding API key; the final overlay held an identical bottom-center anchor across drag, 440×540 expansion, and 116×28 collapse. Fifty immediate expand/collapse cycles completed with zero frame or input failures. Repeated launches, including after a rebuild, reached Ready with no SecurityAgent prompt. Chrome, Calendar, and Discord launched; named Chrome UI inspection and Reload activation succeeded. Outlook was not installed and returned that exact macOS error.

## External release validation still required

These are environment/release gates, not missing implementation:

1. Run the full voice-to-verified-change golden path with production OpenAI Realtime and each supported coding backend on clean accounts.
2. Exercise microphone permission, the Fn/Globe wake gestures (including macOS double-Fn Dictation and Globe-key conflicts plus terminal Secure Keyboard Entry), `⌥Space`, VoiceOver, real speaker playback/truncation, and focused VS Code handoff on clean physical Macs.
3. Run the documented 10-minute conversation/reconnect and concurrent-save acceptance matrix with production providers.
4. Sign with the team’s Developer ID certificate, submit with its notary profile, staple, and install the resulting invited-alpha artifact on a clean machine.

## Final implementation pass

- Added explicit OMP, Codex, and Claude backend routing, backend-qualified session recovery, structured event normalization, and existing-login reuse.
- Repaired legacy encrypted `coder.sessionBound` events that predate backend-qualified sessions, allowing existing local databases to start under the current protocol.
- Reworked onboarding so setup cannot finish without a working coder, coding API keys are optional fallbacks, and setup/install/login controls are visible without scrolling.
- Replaced the conflicting shortcut and circular collapsed orb with `⌥Space`, menu-bar activity state, explicit Open/Hide/Quit controls, and a slim state capsule.
- Rebuilt overlay sizing around one persisted anchor and exact fixed frames; deferred `@Published` transitions avoid stale SwiftUI state, and a persistent native collapse target accepts the first click even during immediate mode changes.
- Added arbitrary application launch aliases, accessibility UI inspection, named in-app actions, and multi-step voice-control guidance with visible-result verification.
- Added backend/control regression coverage, protocol generation/consumer checks, reconnect replay, focused editor capture, release packaging, and end-to-end smoke coverage.
- Defaulted local packaging to a stable signing identity so Keychain trusts the same designated requirement across rebuilds; ad-hoc fallback remains explicit and warns about repeated authorization. Hardened Developer ID builds apply the Bun runtime entitlements and launch the embedded daemon successfully.
- Adopted the Wispr Flow interaction model: bare-modifier wake gestures (double-tap hands-free, hold-to-talk, tap-to-stop) recognized by a clock-injected state machine, a live waveform pill fed by real playout-time audio levels, an animated overlay morph, and wake-key conflict guidance in Settings and onboarding.
