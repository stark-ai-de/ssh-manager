# Open-source readiness

This checklist distinguishes repository improvements from the external actions and real-world evidence still needed for broad adoption. It is not a claim that documentation alone makes software production-ready.

## Repository baseline

| Area               | Implementation                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Licensing          | Existing Apache-2.0 license retained; package licenses and bundled dependency notices preserved                             |
| Discovery          | README with audience, honest maturity, quick start, package ownership and documentation navigation                          |
| Onboarding         | Human first-connection guide, MCP configuration, library/client guide and tested examples                                   |
| Operations         | Configuration, compatibility, troubleshooting, backups, upgrade/rollback and uninstall                                      |
| Explanations       | Mermaid overview, trust-boundary, approval, terminal-lifecycle and artifact-flow diagrams with prose                        |
| Alternatives       | Dated, officially sourced comparison with OpenSSH, ssh2, Tabby, Termius and Teleport                                        |
| Community          | Contribution/support/conduct/governance policies and issue/PR templates                                                     |
| Security           | Organization reporting contact, explicit threat model and truthful private-reporting availability                           |
| Maintenance        | Offline docs checks, formatting gate, scheduled dependency updates, pinned workflow actions and CodeQL configuration        |
| Consumer proof     | Local package inventory/offline-install/import smoke check; runtime verifier with negative fixtures                         |
| Release discipline | Clean committed source/provenance retained, preparation checklist and post-publication verification; no implicit publishing |

Use [validation](validation.md) and actual CI results to establish which checks ran on a candidate. Configuration files being present do not prove that GitHub has enabled or executed them.

## Patterns adapted from Agent Skills

Reviewed [stark-ai-de/agent-skills](https://github.com/stark-ai-de/agent-skills/tree/6bbd94ffd80b6963eee614215dd3b5e430a8f875), revision `6bbd94ffd80b6963eee614215dd3b5e430a8f875`, on 2026-10-12. Relevant sources: its [README](https://github.com/stark-ai-de/agent-skills/blob/6bbd94ffd80b6963eee614215dd3b5e430a8f875/README.md), [contribution guide](https://github.com/stark-ai-de/agent-skills/blob/6bbd94ffd80b6963eee614215dd3b5e430a8f875/CONTRIBUTING.md), [security policy](https://github.com/stark-ai-de/agent-skills/blob/6bbd94ffd80b6963eee614215dd3b5e430a8f875/SECURITY.md), [validation](https://github.com/stark-ai-de/agent-skills/blob/6bbd94ffd80b6963eee614215dd3b5e430a8f875/docs/validation.md) and [publishing](https://github.com/stark-ai-de/agent-skills/blob/6bbd94ffd80b6963eee614215dd3b5e430a8f875/docs/publishing.md) guides.

Adapted ideas, not copied machinery:

- Progressive disclosure: a concise README links task-oriented deep guides.
- Established `security@stark-ai.de` contact instead of inventing an address.
- Focused gates with explicit owners, side effects and evidence limits.
- Safe consumer smoke checks and independently pinned artifact identity.
- Read-only workflow defaults, immutable action pins, explicit release/administrator boundaries and honest run summaries.
- Protection for local agent tooling/private notes without publishing those assets.

Not imported: a skills catalog, plugin projections, site framework, Release Please/App credentials, custom runners, provider hooks, large ADR-triplet framework or global skill installation. They are not necessary to operate this three-package SSH project. Agent Skills remains an independent consumer, not a runtime dependency. No code or large text blocks from that repository were vendored.

## Maintainer actions outside this change

These require repository-administrator decisions/permissions or external evidence. They were **not changed automatically**:

- [ ] Enable and test GitHub private vulnerability reporting; the direct organization email remains the documented reporting route. See [GitHub's instructions](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository).
- [ ] Confirm the organization reporting inbox is monitored and that conduct concerns can be routed to an uninvolved maintainer. No response SLA or independent moderation service is promised.
- [ ] Review/enable dependency alerts/security updates and secret scanning/push protection where available. Version-update configuration does not enable these settings by itself.
- [ ] Configure main-branch protection/rulesets: reviewed PRs, resolved conversations, applicable qualification checks, no force pushes/deletion and read-only default workflow permissions. Use actual hosted check names after their first run.
- [ ] Review CodeQL alerts and decide whether its check is required; do not duplicate a conflicting GitHub default setup.
- [ ] Add relevant public topics such as `ssh`, `ssh2`, `typescript`, `mcp`, `terminal`, `sftp` and `developer-tools`. Homepage can point to this repository's documentation; a new website is not required.
- [ ] Authorize the first public release/registry publication only after checking exact source, payload, ownership and compatibility evidence. Validate public downloads afterwards.
- [ ] Qualify additional MCP hosts, native Windows target/agent combinations, browsers/accessibility and operating environments before advertising them as supported.

An independent security audit, managed support, website, funding/sponsorship program, localization and richer product UI may help adoption, but are not prerequisites for a legitimate Apache-2.0 open-source repository and are not implied by this baseline. See the [roadmap](roadmap.md).
