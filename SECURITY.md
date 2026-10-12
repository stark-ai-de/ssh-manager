# Security policy

SSH Manager can authenticate to servers and execute arbitrary remote commands. Report suspected vulnerabilities privately before sharing exploit details.

## Private reporting

Email **[security@stark-ai.de](mailto:security@stark-ai.de)** with the subject `SSH Manager security report`. This is the organization contact also published in the [Agent Skills security policy](https://github.com/stark-ai-de/agent-skills/blob/6bbd94ffd80b6963eee614215dd3b5e430a8f875/SECURITY.md).

Include the affected source commit/package version, impact, platform, and a minimal reproduction using synthetic data. Do **not** send real credentials, vault files, bootstrap/client tokens, production hostnames or personal data. Ask for a suitable secure transfer channel before sending sensitive attachments.

If GitHub displays **Report a vulnerability** on the [security advisories page](https://github.com/stark-ai-de/ssh-manager/security/advisories), you may use that private channel instead. Private vulnerability reporting was disabled at the 2026-10-12 repository inspection; do not assume the button is available. Ordinary GitHub issues and pull requests are public and are not a substitute for private reporting.

## Support and disclosure

This is an early-stage project with best-effort security maintenance, no guaranteed response or remediation time, and no paid bug-bounty program. Reports against current `main` and the newest maintainer-designated release are welcome. No older-version security backport commitment is currently made; a package version of `1.0.0` is not a security certification.

Maintainers should acknowledge the report privately, reproduce it in an isolated fixture, coordinate a fix and regression test, and agree on disclosure timing with the reporter. Publication of an advisory or release is a separate maintainer action. Never ask a reporter to demonstrate an issue on a live third-party system.

## Scope and expectations

Relevant issues include host-verification bypasses, unauthorized target grants, credential disclosure, local API authentication/origin bypasses, writer impersonation, SFTP containment failures and artifact-verification defects. Dependency vulnerabilities should include a plausible affected path when known.

Read the [security model](docs/security-model.md) before deployment. In particular, shell grants are not a command sandbox, same-user untrusted code is not isolated from local credentials, and the encrypted vault is not zero knowledge. Metadata audit is not a tamper-proof compliance log.
