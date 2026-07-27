# Contributing to Mamachi

Thanks for looking. Mamachi is maintained by a small group, and contributions
are genuinely welcome — especially in the three extension lanes below, which
exist precisely so that other people can add things without touching the
control plane.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first. It is written for
someone who has never opened this repo, and it will save you a day.

---

## Ground rules

1. **The controller is authoritative.** No feature may let model prose change
   task state, skip the evidence gate, or bypass the policy ladder. If your
   change needs to, open an issue instead — that is a design conversation.
2. **The voice model never codes.** It gets no shell, filesystem, git, edit, or
   generic MCP tools. Adding one is not a PR, it is a redesign.
3. **Never edit a generated file.** Regenerate. See [Protocol changes](#protocol-changes).
4. **Never edit an applied migration.** Append a new version.
5. **Source text never enters an event payload.** Large content lives in
   artifacts and is referenced by id.
6. **Match the existing style.** Tabs vs. spaces, naming, private `#fields`,
   error message phrasing — copy the neighbours. There is no formatter config;
   the codebase is consistent by hand.

## Getting set up

```bash
bun install
bun run typecheck
bun test
swift test --package-path apps/macos
```

Copy [`.env.example`](.env.example) to `.env` if you want to run the daemon
directly (`bun run daemon`). `bun run demo` walks the state machine with no
providers attached and is the fastest way to see the controller work.

To build the app:

```bash
bun run macos:build
```

> **Sign with a persistent identity.** If `build-app.sh` can't find a Developer
> ID or Apple Development identity it warns and ad-hoc signs. An ad-hoc rebuild
> changes the code hash, so macOS re-prompts for Keychain access to
> `com.mamachi.app` items on *every* rebuild. Set `MAMACHI_SIGN_IDENTITY` once
> and the prompts stop.

## Before you open a pull request

- `bun run typecheck` clean
- `bun test` green
- `swift test --package-path apps/macos` green if you touched Swift
- `cd packages/protocol && bun run bindings:check` clean if you touched schemas
- New behavior has a test that would fail without your change
- If you closed one of the gaps listed in
  [ARCHITECTURE §11](docs/ARCHITECTURE.md#11-design-vs-implementation), delete
  that entry in the same PR

Small fixes — bugs, docs, tests, a missing edge case — go straight to a PR.
Anything that changes the protocol, the state machine, the policy ladder, the
evidence gate, or the voice tool surface should start as an issue so we can
agree on the shape first.

---

## Extension lane 1 — a new coding backend

**Difficulty: medium. Highest-value contribution in the repo.**

Today Mamachi drives embedded OMP, Codex CLI, and Claude Code. Any agent with a
non-interactive mode and a structured event stream can join. Aider, Cursor CLI,
Gemini CLI, and OpenCode are all plausible.

The interface is seven members (`packages/core/src/coding-runner.ts`):

```ts
interface CodingBackendRunner {
  configure(settings: RuntimeSettings): void;
  updateEditorState(state: EditorDocumentState): void;
  askCoder(taskId: string, question: string): Promise<boolean>;
  steer(taskId: string, clarification: string): Promise<boolean>;
  followUp(taskId: string, addition: string): Promise<boolean>;
  handleEvents(events: readonly DomainEvent[]): void;
  dispose(): Promise<void>;
}
```

It is structural — no `implements` clause needed. `handleEvents` is the only
drive path; runners are event consumers.

Checklist:

1. `packages/core/src/model-router.ts` — add the id to `codingBackends`.
2. New `packages/core/src/<name>-runner.ts` matching the shape.
3. `coding-runner.ts` — add the key to `#runners`. `Record<CodingBackend, …>`
   makes this a compile error until you do.
4. `packages/protocol/src/index.ts` — widen
   `EventPayloadSchemas["coder.sessionBound"].properties.backend.enum`, or
   `parseDomainEvent` rejects your session binding at runtime.
5. `cd packages/protocol && bun run bindings:generate` and commit all four
   generated files.
6. Widen the three hand-written unions that are *not* derived from
   `codingBackends`: `CodingSessionRecord.backend` (`domain.ts`) and
   `recordCoderSession` in both `controller.ts` and `ipc-server.ts`.
7. `packages/core/src/index.ts` — export the runner and its options type.
8. `daemon.ts` — thread any executable path or credential.
9. macOS: `CodingAgentBackend`, `CodingAgentDiscovery.executable(for:)`,
   `status(for:storedProviders:)`, `setupScript(for:executablePath:)`.

Your runner must honor the contract, not just the types:

- **Stop at a safe boundary.** Either intercept before each tool (like
  `OmpRunner`) or supervise the process turn (like `ExternalCliRunner`). Never
  kill mid-write.
- **Persist and resume the session.** Backend-qualified. A task pinned to your
  backend must resume in the same session, in the same repository.
- **Normalize events into evidence** via `onRecordEvidence`, so the completion
  gate and `FactProjector` see real file changes and real verification runs.
- **Route every tool through `onAuthorizeTool`** before it executes, and through
  `WorkspaceGuard` before it writes.
- **Never fall back to another backend or another account.**

Model your tests on `packages/core/test/external-cli-runner.test.ts`, which
drives a fake NDJSON stream end to end.

## Extension lane 2 — a new voice engine

**Difficulty: medium-high.**

Two exist: `RealtimeBridge` (OpenAI Realtime, speech-to-speech) and
`CascadeBridge` (ElevenLabs STT → OpenAI Responses → ElevenLabs TTS). A local
engine, a different provider, or a text-only bridge all fit.

Start at `packages/core/src/voice-bridge.ts` — it is pure contract and imports
neither bridge.

1. Append the id to `voiceEngines`. `parseRuntimeSettings` picks it up.
2. Write `packages/core/src/<engine>-bridge.ts` exporting
   `class <Engine>Bridge implements VoiceBridge` (12 members).
3. `<Engine>BridgeOptions extends VoiceHostCallbacks`, adding `emitAudio`,
   `createToolkit: VoiceToolkitFactory`, provider keys, and endpoint override
   fields as test seams.
4. **Build the toolkit from `createVoiceToolkit`, once, in the constructor.**
   Do not hand-roll a tool surface.
5. Wire `daemon.ts`: `activeVoice()` and the engine-switch branch of the
   settings-update hook.

> **Copy `CascadeBridge`, not `RealtimeBridge`.** `RealtimeBridge` predates the
> shared toolkit and carries a private near-duplicate of all 22 tools. It is
> legacy and is being migrated. Until then, any change to the tool surface must
> land in **both** `voice-toolkit.ts` and `realtime-bridge.ts`.

Non-obvious requirements your engine must get right:

- **Barge-in truncates to audio the user actually heard**, using the
  `PlaybackCursor` the app reports — not to what you sent. Cascade shows how to
  do this locally from TTS character alignment when the provider keeps no
  history.
- **Transcripts are provisional** until the turn is accepted. Speech heard while
  disengaged, or discarded by `wait_for_user`, must never surface as user text.
- **Sleeping must not stop coding**, and a provider failure must not touch task
  state.
- **Briefs queue durably** through `VoiceBriefStore` and flush on re-engagement.

`packages/core/test/cascade-bridge.test.ts` mocks all three provider legs; copy
its structure.

## Extension lane 3 — a new editor client

**Difficulty: low-medium. Good first substantial contribution.**

The protocol is editor-neutral by design and the bindings are generated. The VS
Code extension is just the first consumer; JetBrains, Neovim, Zed, and Emacs are
all reachable.

A client needs to:

1. Read the connection descriptor (`MAMACHI_CONNECTION_PATH`, default
   `~/Library/Application Support/Mamachi/connection.json`) for the port and
   token.
2. Connect to `ws://127.0.0.1:<port>/ws` with
   `Authorization: Bearer <token>`.
3. Send `state.get {afterSeq}` on connect, honor the `reset` flag, replay events
   above `snapshot.seq`, and dedupe by event id.
4. Report focus with `workspace.focus` and document state with `editor.state` —
   **metadata only**: `{workspace, path, version, dirty, open}`.
5. Answer `editor.context.request` with `editor.context.response`, capturing
   content only on an explicit user gesture, within the documented caps.
6. Reconnect with bounded backoff.

`apps/vscode/src/realtime-client.ts` is ~400 lines and is the reference.
`apps/vscode/test/realtime-client.test.ts` pins the exact contract, including
the backoff sequence.

---

## Other good first issues

- **Close a gap in [ARCHITECTURE §11](docs/ARCHITECTURE.md#11-design-vs-implementation).**
  Each entry is a real, scoped, verifiable piece of work.
- **`MAMACHI_VERSION` does not version the app bundle.** `Info.plist` hardcodes
  `0.1.0`; `build-app.sh` should rewrite it.
- **No app icon** is produced or copied.
- **Policy ladder coverage.** New destructive patterns are easy to add and easy
  to test; mind the first-match ordering.
- **`Info.plist` has no `NSAppleEventsUsageDescription`** although an
  `apple_script` computer-control capability is exposed in Settings.

## Protocol changes

The canonical schemas live in `packages/protocol/src/index.ts`. Four generated
files derive from them, and `packages/protocol/test/generated-bindings.test.ts`
fails the suite if any is stale.

```bash
cd packages/protocol
bun run bindings:generate    # rewrite all four
bun run bindings:check       # CI-style drift check
```

Commit the regenerated files with your change. Hand-written duplicate DTOs are
prohibited — if you find yourself typing an interface that mirrors a schema,
stop and generate it.

Adding an IPC request type takes **three** edits or it is silently rejected: the
`RequestEnvelope` union, the `supported` set in `parseRequest`, and `#dispatch`.

## Tests

Tests here defend observable contracts. A test that asserts a default value or
re-states an implementation detail will be asked to justify itself; a test that
would fail on a plausible bug is welcome.

Keep them deterministic and isolated — the existing suites use in-memory SQLite,
mock provider servers, injected clocks, and `ProcessRunner`/`platform` seams
rather than sleeping or hitting the network.

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](SECURITY.md).

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Contributions are accepted under the [MIT License](LICENSE).
