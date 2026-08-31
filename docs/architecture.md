# Architecture

The bot is a small Node.js composition root around a OneBot WebSocket client.

## Data flow

1. The OneBot adapter receives group events and normalizes message segments.
2. `MessageEngine` classifies explicit commands before chat handling.
3. `GroupStateStore` holds per-group runtime switches and transient state.
4. Action implementations perform platform operations such as temporary mute.
5. `ChatService` owns per-group transcripts and calls an OpenAI-compatible endpoint when configured.
6. Prompt, reminder, and ignore registries persist validated JSON snapshots outside the source tree.

`HotRuntime` owns long-lived state and reloads replaceable modules without losing registries, chat memory, or scheduled tasks. `runtime-state.js` provides a process lock so two bot instances do not run against the same bot root.

## Boundaries

External event payloads are normalized at the OneBot client boundary. Configuration is read from environment variables and a caller-selected JSON rules file. Provider credentials and runtime files belong to the operator's local bot root and are never part of this release.

The example uses placeholder group and user values only. Replace them in local fixtures and configuration; do not commit real identifiers.
