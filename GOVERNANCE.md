# Governance

SSH Manager is maintained by **stark-ai-de**. It is an early-stage, maintainer-led open-source project, not a foundation-governed service with an elected board or support SLA.

## Decisions and contributions

Contributors propose changes through issues and pull requests. Maintainers review scope, security, tests, compatibility and ongoing maintenance cost. A maintainer with repository permissions makes merge/release decisions; contribution alone does not grant those permissions. Use [support](SUPPORT.md) for questions and the [code of conduct](CODE_OF_CONDUCT.md) for disagreements involving conduct.

Routine changes should follow existing architecture and contracts. Changes to package ownership, authentication, state compatibility or release policy need a reviewed decision before dependent implementation. Record such a decision in a focused repository-owned ADR when one is needed; do not import another repository's ADR IDs or governance framework as binding policy.

## Ownership

| Area                    | Review responsibility                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| Canonical library       | Trust, grants, credentials and truthful resource lifecycles           |
| Runtime and viewer      | Authenticated client identity, local transport and browser boundaries |
| MCP                     | Tool schemas/annotations and preservation of management API policy    |
| Build and distribution  | Reproducibility, license notices, inventory and source identity       |
| Documentation/community | Accurate onboarding, evidence, comparisons and safe reporting         |

These are review areas, not claims that five separate teams exist. The current maintainers collectively cover them. Do not add a `CODEOWNERS` team handle without confirming the team exists and has access.

## Releases and compatibility

Only explicitly authorized maintainers publish releases, merge changes or authorize live SSH changes. [Release preparation](docs/releases.md) is distinct from publication. Package versions do not establish production readiness, and compatibility claims must identify the actual qualification evidence.

Maintainers should announce breaking changes, document migrations and rollback limits, and provide replacement guidance before removing a supported interface. No fixed release cadence or long-term backport window is promised. Priorities are tracked in the [roadmap](docs/roadmap.md), not delivery commitments.
