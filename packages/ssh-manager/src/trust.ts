import fs from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { fault, type Profile } from "./contracts.js";
import { StateStore } from "./state.js";

export const fingerprint = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
function patternMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("|1|")) {
    const [, , salt, digest] = pattern.split("|");
    if (!salt || !digest) return false;
    const actual = createHmac("sha1", Buffer.from(salt, "base64")).update(host).digest();
    const expected = Buffer.from(digest, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i").test(host);
}
export function knownHostMatches(patterns: string, host: string) {
  const parts = patterns.split(",");
  if (parts.some((p) => p.startsWith("!") && patternMatches(p.slice(1), host))) return false;
  return parts.some((p) => !p.startsWith("!") && patternMatches(p, host));
}
export class HostTrust {
  constructor(
    private state: StateStore,
    private knownHosts: string[],
  ) {}
  snapshot() {
    const digest = createHash("sha256");
    for (const file of this.knownHosts) {
      digest.update(file).update("\0");
      if (!fs.existsSync(file)) {
        digest.update("absent\0");
        continue;
      }
      if (fs.statSync(file).size > 8 * 1024 * 1024)
        fault("LIMIT", "known_hosts exceeds the allowed size.");
      digest.update(fs.readFileSync(file)).update("\0");
    }
    return digest.digest("hex");
  }
  verify(profile: Profile, key: Buffer) {
    const typeLength = key.length >= 4 ? key.readUInt32BE(0) : 0;
    if (
      typeLength > 0 &&
      typeLength <= key.length - 4 &&
      key
        .subarray(4, 4 + typeLength)
        .toString()
        .includes("-cert-v01@openssh.com")
    )
      fault(
        "UNSUPPORTED_HOST_CA",
        "SSH host certificates are outside this version's trust contract.",
      );
    const host = profile.port === 22 ? profile.host : `[${profile.host}]:${profile.port}`;
    let known = false,
      matched = false,
      ca = false;
    for (const file of this.knownHosts) {
      if (!fs.existsSync(file)) continue;
      if (fs.statSync(file).size > 8 * 1024 * 1024)
        fault("LIMIT", "known_hosts exceeds the allowed size.");
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (!fields[0] || fields[0].startsWith("#")) continue;
        const marker = fields[0].startsWith("@") ? fields.shift() : undefined;
        const [patterns, , encoded] = fields;
        if (!patterns || !encoded || !knownHostMatches(patterns, host)) continue;
        const same = Buffer.from(encoded, "base64").equals(key);
        if (marker === "@revoked" && same)
          fault("HOST_KEY_REVOKED", "Host key is revoked.", { targetId: profile.id });
        if (marker === "@cert-authority") {
          ca = true;
          continue;
        }
        if (marker) continue;
        known = true;
        if (same) matched = true;
      }
    }
    const pins = this.state.data.pins.filter(
      (p) => p.profileId === profile.id && p.revision === profile.revision,
    );
    if (pins.some((p) => p.revoked && p.fingerprint === fingerprint(key)))
      fault("HOST_KEY_REVOKED", "Host key is revoked.");
    if (matched) return true;
    if (known)
      fault(
        "HOST_KEY_CHANGED",
        "Host key differs from known_hosts; verify it locally before connecting.",
        { targetId: profile.id, fingerprint: fingerprint(key) },
      );
    if (pins.some((p) => !p.revoked && p.key === key.toString("base64"))) return true;
    if (pins.some((p) => !p.revoked))
      fault("HOST_KEY_CHANGED", "Host key differs from the confirmed pin.", {
        targetId: profile.id,
        fingerprint: fingerprint(key),
      });
    if (ca)
      fault(
        "UNSUPPORTED_HOST_CA",
        "SSH host certificates are outside this version's trust contract.",
      );
    fault("HOST_KEY_UNKNOWN", "Confirm this host fingerprint through trusted local setup.", {
      targetId: profile.id,
      fingerprint: fingerprint(key),
    });
  }
}
