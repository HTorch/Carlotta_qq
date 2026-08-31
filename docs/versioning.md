# Versioning

This project follows semantic versioning while the public API is still forming.

- Patch releases contain compatible fixes and documentation corrections.
- Minor releases add compatible commands, adapters, or configuration fields.
- Major releases change runtime contracts, persistence formats, or required setup.

Before a release, run the complete test suite and `bash scripts/check-release.sh`. Review the staged file list, create a focused release commit, tag the commit from clean `main`, and publish notes that call out configuration changes without copying local values.
