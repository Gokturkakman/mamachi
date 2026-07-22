# Mamachi PRD Implementation Status

**Audit date:** 2026-07-22  
**Compared against:** `PRD.md`  
**Current stage:** Working integrated development prototype; not yet invited-alpha ready

## Bottom line

The core loop is real:

> Voice or text request → durable queued task → headless OMP execution → current-working-tree changes → task state/result → native UI and spoken update

The largest remaining areas are authoritative risk policy, evidence-grounded completion, concurrent-edit protection, the full task UI, and distribution/privacy hardening.

## What is implemented

### Controller and persistence

- Strict JSON Schema validation for task submission, pause, revision, resume, cancellation, and queue movement.
- UUIDv7 command and event identifiers.
- Append-only SQLite command and event log.
- Command idempotency.
- Snapshot and event replay.
- One active task plus a global queue.
- Atomic start of the next queued task.
- Versioned task specifications and immutable repository identity.
- Run boundaries for initial execution and resumed revisions.
- Safe-boundary pause state machine.
- Cancellation and terminal-state invariants.
- Restart recovery that records `run.interrupted` and leaves the task paused for explicit resume.
- Bounded, locally persisted editor-context artifacts.

Primary implementation: `packages/core/src/controller.ts`, `event-store.ts`, `domain.ts`, and `artifact-store.ts`.

### Headless OMP execution

- Exact OMP dependency pin: `17.0.7`.
- Embedded `createAgentSession()` usage rather than TUI scraping.
- Headless execution in the selected current working tree.
- User-configurable primary model, fast model, thinking level, and automatic routing.
- Read-only and research tasks can route to the fast model.
- Tool and assistant activity events.
- Pre-tool hook that blocks execution when a pause is requested.
- Abort on cancellation.
- Explicit context attachments passed into the task.
- Basic coder-input request path using `MAMACHI_NEEDS_INPUT`.
- Prompt-level instructions to preserve existing changes, avoid publication, and verify work.

Primary implementation: `packages/core/src/omp-runner.ts` and `model-router.ts`.

### Realtime voice and conversation

- OpenAI Realtime 2.1 WebSocket connection.
- Duplex 24 kHz PCM audio.
- Server VAD with automatic response creation disabled.
- Explicit `response.create`.
- Streaming user and assistant transcripts.
- Local playback cancellation and response cancellation on barge-in.
- Voice and silent-text response modes.
- Concurrent coding and voice conversation.
- Strict Realtime function schemas with `additionalProperties: false`.
- Implemented tools for:
  - task submission
  - task status
  - pause, resume, and cancel
  - task revision
  - repository inspection delegation
  - web research delegation
  - workspace lookup
  - overlay expansion and collapse
  - silent waiting
- Proactive completion, failure, and input-needed response generation.
- Silent status and interface-control tool calls.
- Spoken overlay expansion verified live.

Primary implementation: `packages/core/src/realtime-bridge.ts`.

### Native macOS application

- Menu-bar application.
- Global `⌘⇧Space` hotkey.
- Floating AppKit `NSPanel` using the non-activating panel style.
- Compact animated voice orb.
- Expandable conversation and current-task drawer.
- Live and persisted transcripts.
- Voice and text mode switching.
- Pause, resume, and cancel controls.
- Model, routing, and thinking settings.
- OpenAI Realtime key stored in macOS Keychain.
- Local transcript clearing.
- Native task-completion, failure, and attention notifications.
- Notification click opens the expanded overlay.
- Local daemon lifecycle.
- Local `.app` packaging.

### VS Code extension

- Focused workspace reporting.
- Explicit capture of:
  - active file metadata
  - selected source text
  - diagnostics
  - bounded terminal excerpts
- Context remains local and attaches once to the next task.
- Workspace boundary checks.
- Mamachi deep-link URI handler that opens a file and position.
- Status-bar connection state.

### Live execution evidence

The persisted application state contains completed mutating, research, and repository-inspection tasks. The integrated OMP path has created files, inspected repository state, run web research, and returned task results through the daemon.

## PRD coverage by implementation slice

| PRD slice | Current state | Major remaining work |
|---|---|---|
| 1. Protocol and controller | Substantial | Full event catalog, intent and approval entities, consumer `afterSeq` recovery, generated client bindings, real migration framework |
| 2. Headless OMP run | Substantial | Persistent OMP sessions, direct `steer()` and `followUp()`, structured coder questions, policy interception, write attribution |
| 3. Policy and observer | Largely missing | Hard risk policy, policy-model role, fact projector, observer model, evidence validator, semantic progress events |
| 4. Realtime voice | Substantial | Correct sleeping and brief behavior, provider transcript truncation, reconnect, long-session compaction, replaceable state, complete PRD tool contract |
| 5. macOS and VS Code | Partial | Full drawer, queue UI, attachment chips, approval cards, changed-file and evidence views, save attribution, onboarding |
| 6. Alpha hardening | Mostly missing | Standalone bundle, Developer ID signing and notarization, diagnostics, encryption, migration and recovery matrix, evaluations |

## Critical correctness gaps

### 1. Completion is not evidence-grounded

This is the most important PRD violation.

- `OmpRunner` passes the final assistant prose directly to `completeTask`.
- `daemon.ts` supplies no evidence IDs.
- The controller permits `task.completed` with an empty evidence array.
- At audit time, the persisted database contained 16 completed tasks; all 16 had empty `evidenceIds`.

The controller currently knows that OMP said it completed and verified work, not that matching tool or verification evidence exists.

Needed:

- Persist tool execution and result artifacts.
- Project deterministic file and verification facts.
- Require valid evidence IDs before accepting completion.
- Distinguish implementation completion from verification completion.
- Expose those artifacts to status answers and the drawer.

### 2. Risk policy is prompt-level, not authoritative

Current enforcement consists mainly of:

- Realtime prompt instructions.
- A small objective regex for deployment, publication, and destructive phrases.
- OMP system instructions.
- `autoApprove: true` for the OMP session.

The controller never returns `confirmation_required`, and there are no stored confirmations or approvals. The live task history also contains a completion summary stating that OMP created commit `f6ab705`, despite the OMP system prompt saying not to commit. This demonstrates that prompt instructions are not a hard policy boundary.

Needed:

- Controller-owned dispatch and action policy.
- Pre-tool checks for destructive Git and filesystem operations, credentials, publication, deployment, purchases, and out-of-repository access.
- Single-use, revision-bound confirmation records.
- Exact visual approval cards.
- Audit events for proposed, approved, rejected, and executed effects.

### 3. The passive observer does not exist

`recentActivity` is currently a small in-memory map derived from raw OMP events. There is no:

- deterministic fact projector
- observation packet
- observer model invocation
- evidence-ID validator
- semantic phase, step, decision, or blocker event stream
- durable observer state

Consequently, status is authoritative for the task state but not yet for meaningful progress or verification evidence.

### 4. Concurrent user-edit protection does not exist

Missing from both the daemon and VS Code extension:

- editor-save attribution
- filesystem watcher
- coder read/write identity tracking
- overlap detection
- stale overwrite prevention
- reconciliation
- semantic conflict state

“Preserve existing changes” is currently only an OMP prompt instruction.

### 5. Sleeping voice behavior is incorrect

Native notifications exist, but the complete PRD behavior does not.

Current code can:

1. Keep the Realtime connection open after microphone disengagement.
2. Generate a proactive response for completion or failure.
3. Play received audio without checking `isEngaged`.

A background completion can therefore speak while the microphone and session are supposed to be sleeping. There is no durable `brief.queued` or `brief.delivered` state.

Needed:

- Authoritative engagement state shared with the daemon.
- Never call `response.create` while disengaged.
- Queue the brief.
- Notify visually.
- Inject and speak the brief only when the user resumes.

### 6. Barge-in is incomplete

Local playback is cleared and `response.cancel` is sent, but unheard assistant audio is not removed or truncated from provider conversation history. No `conversation.item.truncate` equivalent is implemented.

### 7. Coder questions cannot be answered precisely

A coder can transition to `awaiting_user`, but there is no request ID or `answer_task_question` path. Resume simply runs the task prompt again. The user’s answer is not tied to the exact outstanding question.

Also absent:

- `ask_coder`
- structured `respond_to_user_query`
- safe clarification via `steer()`
- non-urgent addition via `followUp()`

## Product-surface gaps

### Overlay and drawer

The current compact surface is essentially only the orb. The PRD also requires visible repository, transcript, coding state, and disengage information.

The expanded drawer still needs:

- full queue list and reorder controls
- task-spec revision history
- grounded current phase and step
- pending confirmations
- permission cards
- decisions and blockers
- changed-file summary
- verification evidence
- run, pause, and recovery boundaries
- working file and range deep links

### Editor context

Capture works, but captured attachments are not rendered as removable chips before dispatch. `pendingContexts` exists in `AppModel`, but the overlay does not display or remove individual items.

The VS Code extension also does not report editor-originated saves.

### Workspace targeting

Focused workspace and pinned selection work. Still missing:

- known repository registry
- available-workspace listing
- confidence model for inferred switches
- confirmation of low-confidence switches
- moved or missing repository presentation
- consistently visible repository chip in the compact surface

### Voice tool contract

The implemented tool list differs significantly from PRD section 16. Missing tools include:

- `list_coding_profiles`
- `capture_editor_context`
- detailed status views
- `get_task_artifact`
- `answer_task_question`
- `ask_coder`
- `manage_queue`
- `resolve_confirmation`
- `remember_fact`
- `forget_fact`

The current `submit_task`, `get_workspace`, and `get_task_status` schemas are also narrower than the PRD contract.

## Persistence, IPC, and privacy gaps

### Storage model

At audit time, the live SQLite database had four tables:

- `commands`
- `events`
- `context_artifacts`
- `schema_migrations`

Still missing or represented only indirectly:

- projects
- voice sessions
- transcript turns
- intent drafts
- task-spec revision read models
- confirmations
- questions
- general artifacts and evidence
- explicit memories

Transcripts are stored separately in plaintext JSON with macOS file protection, not encrypted with an application key from Keychain.

### IPC deviation

The PRD specifies a user-owned Unix-domain socket with length-prefixed frames. The implementation uses an authenticated loopback TCP WebSocket.

It does have:

- per-launch bearer token
- `127.0.0.1` binding
- binary audio frames
- versioned envelopes
- connection descriptor permissions

It does not have:

- `afterSeq` reconnect
- snapshot-then-events replay for consumers
- event-ID deduplication in clients
- generated Swift and VS Code bindings

The transport should either be changed or the PRD should explicitly adopt the authenticated loopback WebSocket design.

### Diagnostics and encryption

Not implemented:

- previewable diagnostics export
- diagnostics redaction
- application encryption key
- encryption of sensitive transcript and artifact fields
- provider request-ID capture
- privacy review tooling

No raw microphone audio persistence was found.

## Alpha-release blockers

The generated app builds, but it is not distributable as the PRD’s invited alpha:

- It is ad-hoc signed with `codesign --sign -`.
- It is not Developer ID signed or notarized.
- It expects to locate the Mamachi source checkout.
- It expects an external Bun installation.
- The daemon and dependencies are not bundled into the app.
- No updater or distribution path exists.
- No first-run onboarding flow exists.
- Microphone and notification permission prompts are invoked directly rather than coordinated through onboarding.
- Accessibility and editor-integration setup is absent.
- Only the OpenAI Realtime credential is managed in Keychain; coding-provider credential onboarding is absent.
- Migration testing is limited to a version-1 bootstrap.
- No diagnostics export exists.

## Success criteria status

### Demonstrated

- Durable task dispatch without waiting for OMP completion.
- One active task plus queue.
- Voice and text conversation while coding remains independent.
- Live repository inspection and web-research delegation.
- Current-working-tree mutation.
- Local task status.
- Safe pause, revision, and resume controller behavior.
- Restart-to-paused controller behavior.
- Native notifications.
- Local transcripts.
- Raw audio not persisted.

### Not yet demonstrated or not satisfied

- Complete golden path in one session, including consequential amendment and evidence-backed verification.
- Zero false completion claims.
- Evidence-grounded status and verification.
- Sleeping completion brief semantics.
- Concurrent user edit preservation.
- Stale and revision-bound confirmations.
- Visual approval flow.
- Recovery of a persistent OMP session.
- Provider failure and reconnect scenarios.
- Audio, noise, and intent-policy evaluation sets.
- Hotkey, barge-in, and status latency targets.
- Signed and notarized invited-alpha installation.

## Verification performed for this audit

- `bun run typecheck && bun test`: **24 passed, 0 failed**
- `swift test --package-path apps/macos`: **5 passed, 0 failed**
- VS Code extension typecheck: passed
- VS Code extension bundle build: passed
- `bun run macos:build`: passed; output remains ad-hoc signed

There are currently no automated tests for `OmpRunner`, IPC end-to-end behavior, VS Code runtime behavior, policy, observer and evidence validation, concurrent edits, diagnostics, notarization, or the complete golden path.

## Recommended implementation order

1. Hard policy, confirmations, and approval cards.
2. Structured artifacts, verification evidence, and a completion gate.
3. Fact projector, passive observer, and durable semantic events.
4. Concurrent-edit attribution and stale-write protection.
5. Correct sleep, queued-brief, and barge-in truncation behavior.
6. Coder-question and direct steering contracts.
7. Full drawer, queue, attachment, evidence, and deep-link UI.
8. Persistent OMP recovery and client `afterSeq` reconnection.
9. Canonical generated protocol bindings and storage expansion.
10. Standalone bundling, onboarding, diagnostics, encryption, signing, and notarization.
