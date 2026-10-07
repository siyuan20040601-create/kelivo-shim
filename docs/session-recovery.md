# Native session persistence and recovery

This change keeps the existing single-user Claude process and the existing
`/persona` volume. Native transcripts are linked from the CLI's current
`~/.claude/projects` directory to `/persona/kelivo-session/projects`. Auth,
trust and persona files keep their existing locations.

## Deployment order

1. Work in the owner's `session-recovery` branch. Keep the original main commit
   and the existing native-transcript backup. Upload all six files in this change
   with their original directory paths.
2. Before deploying, stop sending chat messages and check the live service is
   idle (`busy: false`, `queued: 0` on `/health`). Leave enough time before its
   next automatic heartbeat. Do not print or upload private transcript contents.
3. Put this branch's `session-state.js` in the live container as a temporary
   `.mjs` file. Run it with `--import` and the current session's exact native
   `.jsonl` path. It validates that the transcript ends with an assistant text
   response, creates a private checkpoint and records its UUID atomically.
   The default target is `/persona/kelivo-session`.
4. Confirm the import succeeded, then deploy the tested branch to this owner's
   service. Keep the original volume mounted at `/persona`. The entrypoint
   prepares the transcript symlink before starting the server.
5. Use the original Kelivo chat window for the first test message. Check
   `/health` and `/debug`: `session.enabled` must be true, `mode` must be
   `native`, and `phase` becomes `ready` after a confirmed turn.

An explicit import is required for existing native files when state metadata
does not yet exist. The application refuses to invent a new empty session.
Import refuses to replace an existing `state.json`; preserve it and investigate
before attempting any recovery. Do not delete state or volumes to bypass a
failed recovery.

## Recovery and message order

On restart, no Claude process is spawned by a timer. Heartbeat and other internal
rounds wait for a valid session. The first ordinary message triggers recovery:

- Validate the saved checkpoint's SHA-256 checksum and session UUID.
- Preserve a different interrupted native tail in a private file, then restore
  the last confirmed checkpoint into the current project's native location.
- Launch with explicit `--resume <saved UUID>`. Claude's native resume loads its
  transcript before interpreting the input stream. Verify `system/init` and
  `result` session IDs; never accept output from a different UUID.
- Keep subsequent messages queued until the successful result, flushed native
  assistant tail and durable state commit are all confirmed.
- Only then declare the HTTP turn complete and admit internal activity.

Model/worldbook process changes resume the saved native session. An explicit
window-switch request starts a fresh session only after the existing archive
success check passes.

If a checkpoint file is missing, a session created by this implementation may
recover from its complete saved, confirmed text pairs with an explicit recovery
label. This fallback rejects images and oversized history. Imported older
sessions always require native recovery: subsequent HTTP pairs alone cannot
represent their entire earlier conversation. A corrupt checkpoint always fails
closed.

## Request deduplication and failures

Use a stable per-message `Idempotency-Key` or `X-Shim-Message-ID` if the client can
provide one. Otherwise, the shim hashes the system/model and message history up
through the final user message. Trailing partial assistant output is excluded.
An identical single-message body without an ID is conservatively treated as a
retry; a client sending identical legitimate messages must provide distinct
message IDs or the full preceding history.

Admission is persisted before Claude receives input. Completed, active and
uncertain request IDs cannot be resubmitted to the model. A duplicate receives
HTTP 409 for nonstreaming requests or an explicit SSE error. No cached response
is emitted as a second successful reply. Queued inputs not yet sent are rejected
when the active session fails.

On a failed CLI result, wrong session ID, missing/invalid history, write failure
or interrupted turn, the shim emits an explicit error and blocks automatic
processing, and sends one operator alert through the existing Telegram channel
(outside the model's window) so a night-time lockout is noticed. A process
failure never silently completes the HTTP turn.

An impersonated empty round (successful result, empty text, zero output tokens)
is handled separately: it has no confirmable assistant tail, so forcing it
through the checkpoint path would lock the service up. Instead the shim resets
to `pending` without advancing the checkpoint — the round is rolled back on the
next recovery — deletes the round's request ID so the exact same message can be
resent, rejects the turn with a resend hint, and sends a rate-limited operator
notice. The dead-turn watcher keeps its own escalation cadence.

Durable state is pruned every committed round: fallback history is trimmed to a
recent tail (marking it incomplete, which disables only the fallback; native
checkpoints remain the recovery path), and completed/uncertain request IDs
expire after seven days. Reply text is not stored in the request table. An idle
process exit waits for a new real message and resumes; it does not auto-spawn.
Restarting after repair converts remaining inflight IDs to uncertain and restores
only the last confirmed checkpoint. Unknown inputs are not replayed. External
tool side effects from an interrupted round cannot be rolled back; inspect them
before manually creating a different request ID.

An SSE client disconnect alone leaves the model running so its result can still
be confirmed and saved. A separate keepalive change can follow this persistence
deployment. The existing dead-turn watcher remains an alert mechanism and does
not replace the Claude process.

## Validation

Run `npm test` with the repository's existing dependencies. The new deterministic
fixture makes no API calls and contains no private conversations. Tests cover
idle restart, a clean HOME/cwd with only the volume retained, expected-session
verification, interrupted-tail rollback, duplicate concurrent/restarted
requests, SSE disconnect, heartbeat/queue gating, corruption, migration safety,
explicit import and incomplete-history refusal. These validate application
behavior; they do not substitute for the deployed CLI test.

Live acceptance still required:

1. In the original chat, mention a new harmless detail and confirm its reply.
2. Wait for an idle service, restart once, then ask about that detail without
   repeating it. Confirm native recovery and no duplicated messages.
3. Repeat with a fresh rebuild/container while keeping `/persona` mounted.
4. Confirm heartbeat waits during pending/restoring/failed phases, then works
   when the session is ready, idle and the queue is empty.
5. Confirm no respawn/retry loop and inspect only metadata in public diagnostics.

The production path `/src` is supported. Unverified long cwd encodings over 200
characters are refused explicitly. Keep the CLI pinned to the verified version
and test native event/transcript behavior before any future CLI upgrade.
