# Mamachi PRD Implementation Status

**Updated:** 2026-07-22  
**Compared against:** `PRD.md`  
**Current stage:** Invited-alpha implementation candidate; release credentials and real-provider/hardware validation remain external gates.

## Bottom line

The integrated product loop is implemented:

> Voice or text request → risk-aware dispatch → durable queued task → headless OMP execution in the selected working tree → evidence-gated completion → spoken/visual brief and inspectable artifacts

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

### Headless coding agent

- OMP `17.0.7` embedded through `createAgentSession()`; no TUI or terminal scraping.
- User-selectable primary/fast model selectors, thinking level, and automatic routing.
- Exact OMP session ID and session-file persistence, safe-boundary restart recovery, and resumed execution in the original repository.
- Direct `steer()`, `followUp()`, abort, coder-question, and final-summary integration.
- Structured tool-result evidence tied to task and run identities.
- Completion requires persisted successful evidence; file changes require a later successful verification.
- Shell-generated file changes are attributed before evidence classification.
- Coding-provider credentials are loaded into OMP `AuthStorage`; provider keys, the encryption key, and the daemon IPC token are removed from the tool process environment.

### Policy, attribution, and observation

- Harness-side risk policy for routine work, visual approval, and hard rejection.
- Destructive system-wide commands and credential-access attempts are rejected.
- Publication, deployment, purchase, destructive repository operations, and out-of-repository effects require exact visual approval.
- Tool interception occurs before execution; approvals are bound to the exact arguments and current task revision.
- Workspace guard records the baseline, protects dirty/pre-existing user work, detects edits during a tool call, pauses on conflicts, and records explicit reconciliation before resume.
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

- Menu-bar lifecycle and global `⌘⇧Space` hotkey.
- Non-activating, draggable, resizable Wispr-style orb with voice state, coding ring, repository/status badge, pending brief, sleeping state, and attachment indicators.
- Expanded Task/Chat drawer with live transcript, composer, current objective/step, queue, confirmations, coder questions, revision history, changed files, evidence, verification, and controls.
- Native notifications and optional reaction sounds for attention/completion.
- Repository picker plus focused VS Code workspace handoff.
- First-run onboarding for microphone, notifications, Accessibility, repository selection, OpenAI Realtime key, VS Code integration, and an optional coding-provider key.
- Realtime and coding credentials plus the application encryption key are stored in macOS Keychain.
- Preview-before-export diagnostics with an allowlisted, bounded schema that excludes source, transcripts, prompts, tool arguments, credentials, and audio.
- Privacy controls for transcript retention, credential replacement/removal, diagnostics preview/export, and overlay reset.
- Computer-control settings provide Off, Basic, Assistive, Full, and custom capability sets, per-category toggles, and always/sensitive/never confirmation modes.

### VS Code integration and distribution

- Authenticated reconnecting client with deterministic snapshot-plus-sequence replay and bounded backoff.
- Focused workspace and editor dirty/version state reporting without background document content.
- Explicit active-file, selection, diagnostics, and terminal-excerpt capture. Selection and terminal content require user action.
- Generated protocol types/constants are consumed by both clients.
- The standalone macOS bundle embeds the compiled daemon and the compiled VS Code extension.
- Onboarding can install the bundled extension into the user’s VS Code extension directory.
- Packaging supports ad-hoc or Developer ID signing plus optional notarization preflight, submission, and stapling.

## Verification

- `bun run typecheck`: passed.
- `bun test packages/protocol/test packages/core/test`: 79 passed, 0 failed.
- `apps/vscode`: 5 tests passed; typecheck and production bundle passed.
- `swift test --package-path apps/macos`: 11 passed, 0 failed, including overlay snapshots, audio playback drain, privacy diagnostics, transcript encryption/migration, and microphone sleep.
- `apps/macos/build-app.sh`: produced `apps/macos/dist/Mamachi.app` with the embedded daemon and VS Code extension.
- `codesign --verify --deep --strict --verbose=2 apps/macos/dist/Mamachi.app`: valid on disk and satisfies its designated requirement.
- Packaged-daemon smoke: authenticated `server.ready`, `state.get`, and workspace-owned attachment rejection all behaved as specified.

## External release validation still required

These are environment/release gates, not missing implementation:

1. Run the full voice-to-verified-change golden path with production OpenAI Realtime and the selected coding-provider account.
2. Exercise microphone permission, global hotkey, VoiceOver, real speaker playback/truncation, and focused VS Code handoff on clean physical Macs.
3. Run the documented 10-minute conversation/reconnect and concurrent-save acceptance matrix with production providers.
4. Sign with the team’s Developer ID certificate, submit with its notary profile, staple, and install the resulting invited-alpha artifact on a clean machine.

## Final implementation pass

- Added authoritative policy, evidence gating, fact projection, passive observation, concurrent-edit reconciliation, and exact session recovery.
- Completed the Realtime tool contract, durable sleep briefs, provider-history truncation, scoped memory, and risk-aware task amendment.
- Added the full task/artifact drawer, onboarding, standalone extension installation, privacy controls, diagnostics export, and encrypted local storage.
- Added protocol generation/consumer checks, reconnect replay, focused editor capture, release packaging, and end-to-end smoke coverage.
