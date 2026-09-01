# Versioning

This project follows semantic versioning while the public API is still forming.

- Patch releases contain compatible fixes and documentation corrections.
- Minor releases add compatible commands, adapters, or configuration fields.
- Major releases change runtime contracts, persistence formats, or required setup.

Before a release, run the complete test suite and `bash scripts/check-release.sh`. Review the staged file list, create a focused release commit, tag the commit from clean `main`, and publish notes that call out configuration changes without copying local values.

## Continuous checks

Pull requests and pushes to `main` run tests and release checks on Node.js 20 and 22. Dependency update pull requests are managed weekly for npm packages and GitHub Actions through Dependabot.

## Repository policy files

The public repository is distributed under the MIT License in `LICENSE`. Bug reports and feature requests use the forms in `.github/ISSUE_TEMPLATE/`, and pull requests use `.github/pull_request_template.md` to record validation and privacy checks.

Configuration changes must state whether `ONEBOT_AUTO_RECONNECT` remains at its default `false` or explicitly opts into `true`. Release notes should also describe retry and shutdown behavior when those runtime contracts change, without including credentials, private identifiers, or local paths.
