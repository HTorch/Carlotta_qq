# Operations

Use Node.js 20 or 22 and a OneBot WebSocket bridge that exposes event and API channels. The GitHub Actions test matrix runs both supported Node.js versions.

## Setup

On Windows, run `scripts/setup.ps1` from PowerShell. On Linux or WSL, run:

```bash
bash scripts/setup.sh
```

The wizard installs dependencies, creates `config/group-rules.json`, asks for the event/API URLs and optional provider credentials, and writes a local `.env`. The checked-in values are placeholders and do not connect to a real service. Review the generated files before starting. At startup, required environment variables, WebSocket URL protocols, and the group-rules JSON structure are validated before connections begin. Invalid configuration fails early with an actionable error.

Set `ONEBOT_AUTO_RECONNECT=false` to keep the default fail-stop behavior after a socket closes. Set it to `true` to opt into automatic reconnect. Retries use exponential backoff, beginning at 1 second and capped at 30 seconds. Only one reconnect timer is scheduled at a time, and each successful connection resets the backoff.

## Run

```bash
bash scripts/start-all.sh
bash scripts/status.sh
bash scripts/stop-all.sh
```

On Windows, run `scripts/windows-start.ps1`, `scripts/windows-status.ps1`, and `scripts/windows-stop.ps1` from PowerShell. These templates start and stop only the Node.js process; the external OneBot bridge remains the operator's responsibility.

The Node.js process handles `SIGINT`, `SIGTERM`, and normal exit through one idempotent cleanup path. It stops OneBot reconnect/history timers, rejects pending API calls, closes both sockets, removes hot-reload watchers, stops cron scheduling, and releases the runtime lock once. Connection logs remove URL query strings before output, which keeps access tokens out of logs.

Keep `.env`, runtime JSON files, logs, caches, and process state outside version control.
