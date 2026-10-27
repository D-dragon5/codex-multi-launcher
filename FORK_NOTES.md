# Settings-only downstream branch

This branch is based on [JqyModi/codex-multi-launcher](https://github.com/JqyModi/codex-multi-launcher), maintained upstream by JqyModi / Modi. Original source history, project identity, author metadata and upstream links are retained.

Base: upstream v0.1.9, commit `23b76a1546f9e61fb75cc5f053dd22cafa14fd65`.

## Scope

- Optional one-way synchronization of known local preferences, personalization, custom instructions, skills and prompts.
- Independent login credentials and desktop data directories remain under the upstream profile model.
- No shared-history storage, history export on exit, chat-ID mapping or cross-account takeover feature is added by this branch.
- Existing upstream one-time history import remains upstream behavior. Leave it off when creating separate account histories.
- Changes are experimental. Source builds and synthetic tests do not establish real-account concurrent execution or quota attribution.

No account credentials, actual conversation logs, local database files, machine backups or diagnostic fixtures are published. Mock screenshots use fictitious accounts.

## Attribution and licensing

No LICENSE file or package license was present at the base revision. This fork preserves upstream attribution and does not claim to relicense the upstream work or grant broader rights. No official installer or release is published by this fork.

## Development and recovery

Run `npm run build` and `npm run verify:local-settings`. Runtime synchronization keeps before/after backups; see [the settings guide](docs/local-settings-sync.md).

The published settings branch passed the source build and 92 synthetic checks (65 settings-engine assertions and 27 lifecycle checks). Tests block real desktop launches and use fixture profiles only.

Use Git branches and commits to manage source changes. A source rollback and a runtime settings rollback are separate operations: Git does not restore files in a user's external Codex profile.
