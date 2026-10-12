import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  fault,
  identifier,
  capabilities,
  credentialInput,
  profileInput,
  parse,
  type Profile,
  type CredentialRef,
  type TrustPin,
  type Capability,
  type SessionInfo,
  type AuditEvent,
} from "./contracts.js";
import { atomicJson, privateDirectory, now } from "./util.js";

export type StateData = {
  schema: 1;
  revision: number;
  profiles: Profile[];
  credentials: CredentialRef[];
  pins: TrustPin[];
  grants: Record<string, { revision: number; capabilities: Capability[] }>;
  sessions: SessionInfo[];
  audit: AuditEvent[];
  auditSequence: number;
};
export class StateStore {
  private value: StateData;
  private closed = false;
  readonly file: string;
  constructor(readonly directory: string) {
    privateDirectory(directory);
    this.file = path.join(directory, "state.json");
    if (fs.existsSync(this.file)) {
      if (fs.lstatSync(this.file).isSymbolicLink() || fs.statSync(this.file).size > 8 * 1024 * 1024)
        fault("UNSAFE_STATE", "Invalid state file.");
      let raw: any;
      try {
        raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        fault("STATE_CORRUPT", "State metadata is not valid JSON; retain it for recovery.");
      }
      if (raw.schema === 0 && Array.isArray(raw.hosts)) {
        // The old file remains byte-identical for rollback; unsupported versions are never rewritten.
        fs.copyFileSync(
          this.file,
          path.join(directory, "state.before-v1.json"),
          fs.constants.COPYFILE_EXCL,
        );
        raw = {
          ...raw,
          schema: 1,
          profiles: raw.hosts,
          grants: {},
          sessions: [],
          pins: [],
          audit: [],
          auditSequence: 0,
        };
      }
      this.validate(raw);
      this.value = raw;
    } else
      this.value = {
        schema: 1,
        revision: 0,
        profiles: [],
        credentials: [],
        pins: [],
        grants: {},
        sessions: [],
        audit: [],
        auditSequence: 0,
      };
  }
  private validate(data: StateData) {
    if (data.schema !== 1)
      fault(
        "STATE_VERSION",
        "State version is unsupported. Restore a compatible encrypted backup without rewriting this file.",
      );
    if (
      !Number.isSafeInteger(data.revision) ||
      !Array.isArray(data.profiles) ||
      data.profiles.length > 256 ||
      !Array.isArray(data.credentials) ||
      data.credentials.length > 256 ||
      !Array.isArray(data.sessions) ||
      data.sessions.length > 128 ||
      !Array.isArray(data.pins) ||
      !data.grants ||
      !Array.isArray(data.audit) ||
      data.audit.length > 1000 ||
      !Number.isSafeInteger(data.auditSequence)
    )
      fault("STATE_CORRUPT", "State metadata has an invalid shape.");
    for (const profile of data.profiles) {
      const { id, revision, ...input } = profile;
      parse(profileInput, input);
      if (!identifier.safeParse(id).success || !Number.isSafeInteger(revision) || revision < 1)
        fault("STATE_CORRUPT", "Invalid stored profile.");
    }
    const revision = z.number().int().min(1),
      text = z.string().max(200);
    const valid = (schema: z.ZodType, value: unknown) => {
      if (!schema.safeParse(value).success)
        fault("STATE_CORRUPT", "Invalid stored management metadata.");
    };
    for (const credential of data.credentials) {
      const { id, revision: version, ...input } = credential;
      valid(credentialInput, input);
      valid(identifier, id);
      valid(revision, version);
    }
    valid(
      z
        .array(
          z.strictObject({
            profileId: identifier,
            revision,
            fingerprint: z.string().max(100),
            key: z.string().max(32768),
            revoked: z.boolean(),
          }),
        )
        .max(256),
      data.pins,
    );
    valid(z.record(identifier, z.strictObject({ revision, capabilities })), data.grants);
    valid(
      z
        .array(
          z.strictObject({
            id: identifier,
            targetId: identifier,
            state: z.enum(["running", "closed", "lost", "recoverable"]),
            cols: z.number().int().min(2).max(300),
            rows: z.number().int().min(2).max(120),
            tmux: z.boolean(),
            recording: z.boolean(),
            createdAt: text,
            writer: text.optional(),
            reason: text.optional(),
          }),
        )
        .max(128),
      data.sessions,
    );
    valid(
      z
        .array(
          z.strictObject({
            sequence: z.number().int().min(1),
            time: text,
            actorId: text,
            targetId: identifier.optional(),
            action: text,
            outcome: text,
          }),
        )
        .max(1000),
      data.audit,
    );
    if (
      new Set(data.profiles.map((p) => p.id)).size !== data.profiles.length ||
      new Set(data.credentials.map((c) => c.id)).size !== data.credentials.length ||
      new Set(data.sessions.map((s) => s.id)).size !== data.sessions.length
    )
      fault("STATE_CORRUPT", "Duplicate management identifiers.");
  }
  get data(): StateData {
    if (this.closed) fault("CLOSED", "State owner has shut down.");
    return structuredClone(this.value);
  }
  close() {
    this.closed = true;
  }
  change(update: (draft: StateData) => void) {
    const draft = this.data;
    update(draft);
    draft.revision++;
    this.validate(draft);
    atomicJson(this.file, draft);
    this.value = draft;
  }
  audit(actorId: string, action: string, outcome: string, targetId?: string) {
    this.change((d) => {
      d.audit.push({
        sequence: ++d.auditSequence,
        time: now(),
        actorId,
        action,
        outcome,
        ...(targetId ? { targetId } : {}),
      });
      if (d.audit.length > 1000) d.audit.shift();
    });
  }
  session(info: SessionInfo) {
    this.change((d) => {
      const index = d.sessions.findIndex((s) => s.id === info.id);
      if (index >= 0) d.sessions[index] = { ...info, writer: undefined };
      else {
        if (d.sessions.length >= 128) d.sessions.shift();
        d.sessions.push({ ...info, writer: undefined });
      }
    });
  }
}
