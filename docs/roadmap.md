# Roadmap

These are priorities for discussion, not deadlines or promises. Use [feature requests](https://github.com/stark-ai-de/ssh-manager/issues/new?template=feature_request.yml) to explain demand and maintenance value.

## Now: make the existing product usable and inspectable

- Clear developer and MCP onboarding with safe human setup.
- Accurate architecture/security/lifecycle documentation and comparisons.
- Community contribution/support/reporting processes.
- Repeatable validation, package-consumer smoke checks and artifact verification.
- An explicit list of external [release/readiness actions](project-readiness.md).

## Next, after evidence and maintainer review

- First reviewed public runtime release and, if useful, npm packages with verified consumer installation/provenance.
- Named MCP-host installation/approval qualification and broader native-platform/browser coverage.
- More ergonomic trusted-local credential setup that avoids plaintext secret argument files.
- Viewer accessibility/usability assessment and improvements supported by browser evidence.
- Independently reviewed security and recovery exercises before stronger production-readiness claims.

## Requires a separate design decision

Multi-user/remote management, SSO, cloud synchronization, certificate-authority trust, unattended privilege grants, state-format migration or a substantially larger UI change the current boundaries. They should not slip into documentation or maintenance PRs. Never relax host verification, credential isolation or truthful job/session lifecycles for convenience.
