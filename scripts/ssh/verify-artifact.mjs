import { verifyRuntimeArtifact } from "../lib/ssh-runtime-artifact.mjs";

const [directory, manifestSha256, sourceCommit, ...extra] = process.argv.slice(2);
if (!directory || !manifestSha256 || extra.length) {
  console.error(
    "Usage: node scripts/ssh/verify-artifact.mjs <runtime-directory> <trusted-manifest-sha256> [expected-source-commit]",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(
      JSON.stringify(verifyRuntimeArtifact(directory, { manifestSha256, sourceCommit }), null, 2),
    );
  } catch {
    // Do not echo untrusted manifest content or private filesystem paths.
    console.error(
      "Artifact verification failed. Check the trusted pin, source revision and complete unmodified payload.",
    );
    process.exitCode = 1;
  }
}
