# Contributing

1. Create a branch from `main`.
2. Keep changes focused and add or update a built-in Node test for behavior changes.
3. Run `npm test`, `node --check` for changed JavaScript files, and `bash scripts/check-release.sh`.
4. Do not include credentials, personal identifiers, real service endpoints, runtime files, or deployment bundles.

Pull requests should describe the observable behavior change, test commands, and any configuration migration. Keep provider integrations behind environment variables and dependency injection where practical.
