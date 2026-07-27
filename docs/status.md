# Implementation Status

**Compared against:** [product-requirements.md](./product-requirements.md)
**Stage:** pre-1.0, dogfooded daily, no released binaries

This is the honest capability matrix. The design document states intent; this
file states what the code does. Where they disagree, this file and
[ARCHITECTURE §11](./ARCHITECTURE.md#11-design-vs-implementation) win.

## Bottom line

The integrated loop works end to end:

> voice or text request → risk-aware dispatch → durable queued task → selected
> OMP / Codex / Claude session → evidence-gated completion → spoken brief and
> inspectable artifacts

It is local-first and runs one mutating coding job at a time. Conversation,
status queries, safe steering, and unrelated queued work all remain available
while coding runs.

## Verification

Reproduce with:

```bash
bun run typecheck                                  # clean
bun test                                           # 128 pass, 0 fail, 21 files
swift test --package-path apps/macos               # 43 pass, 0 fail
cd packages/protocol && bun run bindings:check     # no drift
bun run macos:build                                # produces a signed .app
```

Those are deterministic suites — in-memory SQLite, mock provider servers,
injected clocks, process seams. They cover the protocol, controller, storage
and migrations, encryption, policy, the evidence gate, the fact projector, the
observer, the workspace guard, both coding-backend runners, both voice engines,
computer control, the IPC server, and the VS Code client.

Provider-facing behavior (real Realtime turns, real Scribe/Flash cascade turns,
real backend logins, microphone and wake-gesture handling on physical hardware)
is exercised manually and is **not** covered by automated tests.

---

## Implemented

### Protocol, controller, persistence

- Strict JSON Schemas for 8 commands and 24 events, `additionalProperties: false`
  throughout, with generated Swift and TypeScript bindings and a codegen drift
  test.
- UUIDv7 identities, idempotent command replay by id, optimistic revisions, and
  single-use revision-and-fingerprint-bound confirmations.
- Append-only SQLite event log as the sole durable truth; in-memory state is a
  pure fold rebuilt by replay, with invariants asserted after every event.
- Versioned, idempotent migrations tracked in `schema_migrations`.
- Sequence-based IPC replay with snapshot-plus-events and a `reset` path for
  stale clients.
- AES-256-GCM field encryption with per-row/column AAD binding, covering event
  and command payloads, context artifacts, evidence, observer notes, memories,
  queued briefs, and native transcripts. Legacy plaintext rows upgrade when a
  key first becomes available.
- Repair pass for `coder.sessionBound` events written before multi-backend
  support, so pre-existing databases still replay.

### Coding backends

- Embedded OMP through `createAgentSession()` with `steer`, `followUp`, abort,
  coder questions, and final-summary integration; tool calls intercepted
  **before** execution.
- Codex CLI and Claude Code driven non-interactively over their structured JSON
  streams, using the user's existing login and native configuration.
- Backend choice is explicit and persisted. Backend-qualified session ids resume
  in the original repository after an accepted pause or a restart. Mamachi never
  silently falls back to another agent or account.
- Structured tool and turn events normalize into evidence. Completion requires
  persisted successful evidence from the finishing run; any file change requires
  a later successful verification.
- Explicit commit tasks get repository-local `.git` write access and a
  commit-authorizing prompt. Non-commit tasks keep the no-commit sandbox.
- A resumed turn receives the user's exact answer; the voice bridge rejects any
  coder answer not grounded verbatim in the current user turn.
- Equivalent in-flight research is deduplicated; substantive coding work is
  ordered ahead of queued fast/research tasks.
- Provider keys, the encryption key, and the IPC token are stripped from the
  environment before any CLI is spawned.

### Policy, attribution, observation

- Twelve-rung first-match risk ladder: routine work automatic, destructive/
  publishing/deploying/purchasing/out-of-repo effects behind visual approval,
  credential access and catastrophic commands hard-rejected and recorded.
- Effect fingerprints bind an approval to the exact tool arguments.
- Workspace guard records baselines, protects dirty and pre-existing user work,
  attributes edits per tool (OMP) or per turn (external CLIs), pauses on
  conflict, and records explicit reconciliation on resume.
- Focused-editor paths canonicalized across macOS symlink aliases.
- Deterministic fact projection separates implementation, verification,
  blocker, decision, file, and progress state from model prose.
- Read-only passive observer receives bounded projected facts, cannot call
  tools, cannot mutate controller state, and cannot add latency to the control
  path.

### Voice

- OpenAI Realtime adapter: duplex 24 kHz PCM, text mode, server VAD,
  interruption, provider-history truncation from exact played-audio metadata,
  bounded reconnect, and inactivity/cancellation watchdogs that replace wedged
  provider sessions automatically. The connection stays open while the
  microphone sleeps.
- Selectable cascaded engine: ElevenLabs Scribe v2 Realtime STT → GPT-5.5 via
  the streaming Responses API (reasoning effort `none`) → ElevenLabs Flash v2.5
  TTS, with chunk-relative character alignment accumulated into an absolute
  timeline so barge-in truncates to exactly the audio the user heard.
- Complete strict tool surface: workspace and profile discovery, explicit editor
  capture, task submission/status/artifacts, exact coder answers, safe task
  changes, queue control, memories, computer control, overlay control, and
  microphone sleep. No shell, filesystem, git, or edit tools.
- Consequential changes pause at a safe boundary, persist a revised spec, and
  resume. Low-risk clarifications use direct steering.
- Completion, failure, and attention briefs queue durably while sleeping and are
  delivered on re-engagement. Open coder questions are restored from controller
  state and proactively relayed after reconnection.
- Realtime failures do not stop coding; coding failures do not end the voice
  session.
- Vision: `look_at_screen` attaches a high-detail image to the current turn and
  detaches it afterward; `capture_screen_context` stores a screenshot as a
  first-class attachable artifact.
- Provider transcriptions stay provisional and are committed to the visible
  transcript only when the turn is accepted. Casual conversation is not durable
  memory.

### macOS surface

- Menu-bar lifecycle; Wispr-style wake gestures on a configurable bare modifier
  (double-tap for hands-free, hold for push-to-talk, tap to barge in or sleep)
  that survive terminal Secure Keyboard Entry; `⌥Space` fallback requiring no
  Accessibility trust.
- Exact-size non-activating collapsed pill with a live capture waveform, a
  playout-timed speech waveform, thinking and connecting states, whole-surface
  drag, and right-click recovery controls.
- Expanded Task/Chat drawer: transcript, composer, objective and current step,
  queue, confirmations, verbatim coder questions, revision history, changed
  files, evidence, verification, controls. Reduce-motion fallbacks throughout.
- Accessibility-gated wake-key monitoring with live status, plus Globe-key
  conflict detection (emoji, input source, dictation) and keyboard-settings
  deep links.
- Audio-route resilience across device switches and sleep/wake, with the capture
  converter pinned to channel 0 so multi-channel voice-processing mic arrays
  cannot phase-cancel speech into silence.
- Native notifications and optional reaction sounds.
- Repository picker and focused VS Code workspace handoff.
- Onboarding requires a working coding agent, detects existing OMP/Codex/Claude
  logins, and offers one-click terminal install and login. A provider key is an
  optional fallback, not a duplicate requirement.
- Keychain-stored credentials and application encryption key; coding
  subscription tokens stay owned by their CLIs.
- Builds automatically select an available persistent Developer ID or Apple
  Development identity so rebuilds do not invalidate Keychain authorization.
- Preview-before-export diagnostics on an allowlisted, bounded schema excluding
  source, transcripts, prompts, tool arguments, credentials, and audio.
- Privacy controls for transcript clearing, credential replacement and removal,
  diagnostics export, and overlay reset.

### VS Code and packaging

- Authenticated reconnecting client with snapshot-plus-sequence replay, event
  deduplication, and bounded backoff.
- Focused workspace and editor dirty/version reporting **without** background
  document content.
- Explicit active-file, selection, diagnostics, and terminal-excerpt capture;
  selection and terminal content require user action.
- Generated protocol types consumed by both clients.
- The macOS bundle embeds the compiled daemon and the compiled extension;
  onboarding can install the extension into the user's VS Code directory.
- Packaging supports ad-hoc, automatic, and Developer ID signing, applies the
  required Bun daemon entitlements under hardened runtime, and provides
  notarization preflight, submission, and stapling.

---

## Not implemented

Each of these is a real, scoped piece of work. Contributions welcome — see
[CONTRIBUTING.md](../CONTRIBUTING.md).

| Gap | Detail |
|---|---|
| One voice tool surface | `voice-toolkit.ts` is canonical (23 tools); `RealtimeBridge` carries a near-duplicate 22-tool private copy. Changes must land in both until the migration completes. |
| Unix-domain socket IPC | The design specifies a Unix socket with length-prefixed frames. Reality is a loopback TCP WebSocket with Bearer auth. Everything else in that section is implemented. |
| ~20 catalogued events | `intent.updated`, `task.phaseChanged`, `plan.updated`, `step.*`, `decision.recorded`, `blocker.*`, `verification.*`, and the `voice.*` lifecycle events have no schema and no emitter. Phase is derived, not evented. |
| Relational read models | Eight tables exist as DDL with zero readers and zero writers. Intent drafts have no implementation at all. |
| Daemon supervision | The daemon recovers its own state on restart, but the app never relaunches or re-attaches to a crashed daemon. |
| External-backend steering | `askCoder`/`steer`/`followUp` return `false` for Codex and Claude; live steering is OMP-only. `steerCoder`/`followUpCoder` are wired in the daemon but no voice tool calls them. |
| Transcript retention policy | Manual clearing only — no age, size, or count policy. |
| App bundle versioning | `MAMACHI_VERSION` writes `daemon-version.json` only; `Info.plist` hardcodes `0.1.0`. |
| App icon, login item, updater | None exist. |
| `NSAppleEventsUsageDescription` | Absent, although an `apple_script` computer-control capability is exposed in Settings. |
| Encryption by default | Sensitive fields are plaintext unless `MAMACHI_ENCRYPTION_KEY` is set. Only the macOS app guarantees a key. |

## Release gates

Environment and process work, not missing implementation:

1. Full voice-to-verified-change golden path against production providers, with
   each supported coding backend on a clean account, on both voice engines,
   including live barge-in truncation and multilingual dictation.
2. Microphone permission, Fn/Globe wake gestures (including macOS double-Fn
   dictation and Globe conflicts plus terminal Secure Keyboard Entry),
   `⌥Space`, VoiceOver, real speaker playback and truncation, and focused
   VS Code handoff on clean physical Macs.
3. The 10-minute conversation/reconnect and concurrent-save acceptance matrix
   against production providers.
4. Signing with a Developer ID certificate, notarization, stapling, and a clean
   install on a fresh machine.
5. A published checksum or signature for whatever artifact is distributed.
