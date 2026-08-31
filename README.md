# Carlotta QQ Bot Architecture

This is a sanitized, reusable Node.js example of a QQ group bot connected through OneBot WebSocket. It contains the message dispatcher, group state, persistence registries, chat and image adapters, focused tests, and generic Windows/WSL operation templates.

## Quick start

On Windows, run `scripts/setup.ps1` in PowerShell. On Linux or WSL, run:

```bash
bash scripts/setup.sh
```

The setup wizard checks Node.js, installs dependencies, creates the local rules file, asks for bridge/provider values, writes `.env` with restrictive permissions, and creates runtime directories. Then run:

```bash
npm test
bash scripts/check-release.sh
```

The checked-in `.env.example` and `config/group-rules.example.json` contain placeholders only. Create local `.env` values for your own bridge and providers. Never commit `.env`, credentials, real identifiers, logs, caches, runtime state, or deployment files.

## Layout

- `src/`: runtime modules and focused tests
- `config/group-rules.example.json`: starter rules shape
- `docs/architecture.md`: ingress, dispatch, state, and persistence boundaries
- `docs/operations.md`: generic setup and platform operation
- `docs/contributing.md`: contribution checks
- `docs/versioning.md`: release workflow
- `scripts/check-release.sh`: fail-closed privacy, syntax, and test gate
- `scripts/setup.sh` / `scripts/setup.ps1`: interactive local initialization wizard
- `scripts/publish.sh`: optional upload helper requiring an explicit staging directory and reviewed remote

## Privacy boundary

The public tree uses `example.invalid` endpoints and small fixture identifiers. Runtime registries write to operator-selected local paths; their generated files are ignored and are not included here. Review the staged file list before every public push.

## License

This release is intended as an open-source learning and reuse package. Add a project license before redistributing it in a larger product.
