## What and why

Explain the problem, intended outcome and boundaries. Link an issue if applicable.

## Validation

List exact commands and results. Mark skipped/not-run checks explicitly and explain why. A fixture pass is not production or native-platform qualification.

## Compatibility and operations

Describe API/state changes, upgrade/rollback implications and user-facing documentation. Say explicitly if there are none.

## Checklist

- [ ] `pnpm validate` passes; relevant native/browser fixtures ran when prerequisites were available.
- [ ] Regression tests and documentation cover the changed contract.
- [ ] Host verification, human grants, credential isolation and authenticated writer identity remain intact.
- [ ] No job replay, false PTY-continuity promise or session termination on vault lock was introduced.
- [ ] No secrets, local state, private paths, identifying host data or unsanitized screenshots are included.
- [ ] Generated artifacts were not hand-edited; public package/API boundaries are preserved.
- [ ] User-visible changes are recorded under `Unreleased` in `CHANGELOG.md`.
- [ ] No publication, live SSH change, GitHub setting change or release tag is implicit in this PR.
