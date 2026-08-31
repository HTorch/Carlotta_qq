# Operations

Use Node.js 20 or newer and a OneBot WebSocket bridge that exposes event and API channels.

## Setup

```bash
bash scripts/setup.sh
```

Review `.env` and `config/group-rules.example.json` locally. Set the event URL, API URL, rules file, and provider credentials for your own environment. The checked-in values are placeholders and do not connect to a real service.

## Run

```bash
bash scripts/start-all.sh
bash scripts/status.sh
bash scripts/stop-all.sh
```

On Windows, run `scripts/windows-start.ps1`, `scripts/windows-status.ps1`, and `scripts/windows-stop.ps1` from PowerShell. These templates start and stop only the Node.js process; the external OneBot bridge remains the operator's responsibility.

Keep `.env`, runtime JSON files, logs, caches, and process state outside version control.
