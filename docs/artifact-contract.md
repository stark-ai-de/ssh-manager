# Runtime artifact contract

`pnpm build` compiles the independent packages and bundles the MCP, daemon and CLI with viewer assets and dependency notices. `pnpm artifact` exports `dist/artifact/runtime` only from a clean committed source tree and checks its build-input hashes against that source.

`ARTIFACT-MANIFEST.json` has format version 1, runtime version, management API version, Node minimum, fixed public source repository, complete source commit, build-manifest SHA-256 and a sorted list of relative file paths, sizes and SHA-256 digests. The manifest does not include itself in its file list. Consumers separately pin its digest.

Required payload includes mcp.mjs, daemon.mjs, cli.mjs, BUILD-MANIFEST.json, NOTICE.txt, LICENSE and viewer assets. Symlinks, special files and path escapes are forbidden. Consumers compare the entire payload inventory, reject missing/extra/mutated files and copy only the verified artifact.

The Skills repository imports a reviewed immutable candidate artifact and records its producer commit and manifest digest. No network, private checkout, dependency installation or source rebuild is required during normal plugin generation. Importing a new version is an explicit operation.

This artifact is a distribution unit, not a claim that a GitHub Release or npm package has been published. Releases and merges require separate authorization. Full dependency notices and build provenance travel with the artifact; local runtime state and secrets do not.
