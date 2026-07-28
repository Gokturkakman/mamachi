# Security Policy

Mamachi runs an autonomous coding agent against your working tree, holds
provider credentials, and opens a local authenticated socket. Security issues
here are real. We take them seriously.

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through GitHub's security advisory interface on this
repository ("Report a vulnerability" under the Security tab). If that is
unavailable to you, contact a maintainer directly through their GitHub profile.

Please include:

- What an attacker can do, and what they need in order to do it
- Affected component (daemon, macOS app, VS Code extension, protocol)
- Reproduction steps or a proof of concept
- Version, commit, and macOS version

We will acknowledge receipt, keep you updated while we investigate, and credit
you in the fix unless you prefer otherwise. Please give us reasonable time to
ship a fix before public disclosure.

## Supported versions

Mamachi is pre-1.0 with no released binaries. Only `main` is supported. Build
from source.

## Threat model

### What Mamachi defends against

**A model that lies about what it did.** Completion requires persisted evidence
belonging to the finishing run, and if any file changed, a successful
verification command must have run *after* the last change. The default
validator refuses everything, so the gate fails closed. A hallucinated evidence
id is rejected. Evidence copied from another run is rejected.

**A model that tries to exceed its remit.** The voice model has no shell, no
filesystem, no git, and no edit tools. Coding-agent tool calls pass through
`assessToolCall` *before* execution. Credential access and catastrophic
commands are hard-rejected and the rejection is recorded. Destructive,
publishing, deploying, purchasing, and out-of-repository effects require an
explicit visual approval whose scope is bound to a SHA-256 fingerprint of the
exact tool arguments, to the task revision, and to single use.

**An agent that clobbers your work.** `WorkspaceGuard` fingerprints the tree
before each run, records pre-existing modifications, and blocks writes that
overlap dirty editor buffers or files you changed. Whole-file replacement of
pre-existing user changes is blocked while anchored edits are allowed. Mamachi
never commits, never switches branches, and never opens a pull request unless a
task explicitly asks for that exact effect.

**Credential leakage into a child process.** The daemon consumes and deletes
provider keys, `MAMACHI_ENCRYPTION_KEY`, and the IPC token from `process.env`.
`ExternalCliRunner` reconstructs a sanitized child environment and removes the
known secret set again at the spawn boundary. Codex and Claude use their own
login stores; they do not receive another backend's provider key.

**Credential leakage into stored data.** Non-routine tool arguments are redacted
before persistence; `credential_access` results are dropped entirely.
Diagnostics export is allowlisted and previewable, and refuses any value
containing a home-directory path or a secret marker.

**Unauthorized local clients.** `/ws` requires a Bearer token compared with
`timingSafeEqual`. The token is a fresh UUIDv7 per launch, published only via
the daemon's stdout handshake and a `0600` descriptor inside a `0700`
directory.

**Data at rest.** Event payloads, command payloads and results, context
artifacts, evidence, observer notes, memories, queued briefs, and native
transcripts are AES-256-GCM encrypted. The AAD binds each ciphertext to its exact
`<table>.<column>:<row-id>`, so a blob cannot be relocated to another row. The
app keeps its key in Keychain; a headless daemon creates a `0600` key beside the
database. Any authentication failure throws.

**Raw audio.** Never persisted.

### What Mamachi does *not* defend against

Be honest with yourself about these before you run it.

- **A malicious or compromised coding agent within its allowed scope.** Routine
  in-repository edits are trusted by design. Mamachi bounds *category* of
  effect, not intent. Review your diffs.
- **Prompt injection through repository content.** A coding agent reading a
  hostile file may be steered by it. Policy catches the dangerous *effects* it
  would try to produce, not the persuasion.
- **A local attacker who already has your user account.** The daemon binds to
  `127.0.0.1` and authenticates, but the token file, the SQLite database, and
  the Keychain are all reachable by anything running as you. There is no
  privilege boundary between Mamachi and other processes you own.
- **Lost encryption keys.** Mamachi cannot recover encrypted state if its
  Keychain item or headless `*.sqlite.key` file is lost. Explicitly setting
  `MAMACHI_ALLOW_PLAINTEXT=1` disables the at-rest guarantee.
- **An unsandboxed app.** The macOS app has no App Sandbox entitlement. The
  daemon binary carries JIT and library-validation exemptions because Bun
  requires them.
- **Enabled `shell` or `apple_script` computer control.** Neither is in the
  default capability set, and both park a confirmation under the default
  `sensitive` mode. If you enable them *and* set the confirmation mode to
  `never`, you have handed the voice model a shell. That is your call to make
  deliberately.
- **Provider-side handling.** Context you send to OpenAI, ElevenLabs, Anthropic,
  or Google is governed by their terms, not ours.
- **Supply chain.** We pin `@oh-my-pi/*` exactly and commit `bun.lock`, but we
  do not audit transitive dependencies.

## Hardening checklist

If you are running Mamachi on a machine that matters:

1. Build and sign with a persistent Developer ID identity. Ad-hoc rebuilds
   change the code hash and retrain you to click through Keychain prompts.
2. Back up the `*.sqlite.key` file with any headless state you need to preserve,
   or inject `MAMACHI_ENCRYPTION_KEY` from your secret manager. Never set
   `MAMACHI_ALLOW_PLAINTEXT=1` on durable state.
3. Leave `computerCapabilities` at the default `assistive` set. Do not enable
   `shell` or `apple_script` unless you need them.
4. Leave `computerConfirmationMode` at `sensitive`.
5. Do not set `MAMACHI_CONNECTION_PATH` to a shared or world-readable location.
   It contains the IPC token.
6. Keep credentials in the Keychain. Use `.env` only for local development, and
   never commit it.
7. Review diffs. Mamachi coordinates; it does not absolve.
