# Operations

Use Node.js 20 or newer and a OneBot WebSocket bridge that exposes event and API channels.

## Setup

On Windows, run `scripts/setup.ps1` from PowerShell. On Linux or WSL, run:

```bash
bash scripts/setup.sh
```

The wizard installs dependencies, creates `config/group-rules.json`, asks for the event/API URLs and optional provider credentials, and writes a local `.env`. The checked-in values are placeholders and do not connect to a real service. Review the generated files before starting.

## Run

```bash
bash scripts/start-all.sh
bash scripts/status.sh
bash scripts/stop-all.sh
```

On Windows, run `scripts/windows-start.ps1`, `scripts/windows-status.ps1`, and `scripts/windows-stop.ps1` from PowerShell. These templates start and stop only the Node.js process; the external OneBot bridge remains the operator's responsibility.

Keep `.env`, runtime JSON files, logs, caches, and process state outside version control.
