# Architecture

The bot is a small Node.js composition root around a OneBot WebSocket client. Supported runtimes are Node.js 20 and 22, both covered by CI.

## Data flow

1. The OneBot adapter receives group events and normalizes message segments.
2. `MessageEngine` classifies explicit commands before chat handling.
3. `GroupStateStore` holds per-group runtime switches and transient state.
4. Action implementations perform platform operations such as temporary mute.
5. `ChatService` owns per-group transcripts and calls an OpenAI-compatible endpoint when configured.
6. Prompt, reminder, and ignore registries persist validated JSON snapshots outside the source tree.

`HotRuntime` owns long-lived state and reloads replaceable modules without losing registries, chat memory, or scheduled tasks. `runtime-state.js` provides a process lock so two bot instances do not run against the same bot root.

## Boundaries

External event payloads are normalized at the OneBot client boundary. Configuration is read from environment variables and a caller-selected JSON rules file. Startup validates required WebSocket URLs, their `ws://` or `wss://` protocols, and the rules-file shape before the runtime lock is claimed or sockets are opened. Provider credentials and runtime files belong to the operator's local bot root and are never part of this release.

The OneBot client opens separate event and API sockets. Automatic reconnect is disabled by default through `ONEBOT_AUTO_RECONNECT=false`; setting it to `true` enables exponential backoff from 1 second to a 30 second maximum. Reconnect scheduling is bounded to one pending timer, and shutdown cancels it.

The process uses one idempotent cleanup path for signals and normal exit. Cleanup stops reconnect and history timers, rejects pending API requests, closes open or opening sockets, and releases the runtime lock once. Socket URLs are redacted before they are logged, including removal of query strings that may carry access tokens.

The example uses placeholder group and user values only. Replace them in local fixtures and configuration; do not commit real identifiers.
