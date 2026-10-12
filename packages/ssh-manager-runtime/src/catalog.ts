import { z } from "zod";
import {
  profileInput,
  credentialInput,
  identifier,
  capabilities,
  endpoint,
} from "@stark-ai/ssh-manager/contracts";

const target = { targetId: identifier };
const revision = { expectedRevision: z.number().int().min(1) };
const session = { sessionId: identifier };
const cursor = z.number().int().min(0).optional();
const remote = { ...target, path: z.string().min(1).max(2048) };
const size = { cols: z.number().int().min(2).max(300), rows: z.number().int().min(2).max(120) };
const secret = z
  .string()
  .min(1)
  .max(2 * 1024 * 1024);
function operation<T extends z.ZodRawShape>(
  description: string,
  shape: T,
  options: { operator?: boolean; readOnly?: boolean; destructive?: boolean; remote?: boolean } = {},
) {
  return {
    description,
    schema: z.strictObject(shape),
    operator: options.operator ?? false,
    annotations: {
      readOnlyHint: options.readOnly ?? false,
      destructiveHint: options.destructive ?? false,
      openWorldHint: options.remote ?? false,
      idempotentHint: options.readOnly ?? false,
    },
  };
}
/** Finite reviewable inventory. Operator setup actions are API/CLI-only and never MCP tools. */
export const catalog = {
  ssh_hosts_list: operation(
    "List and search explicit host profiles and groups without opening connections.",
    { search: z.string().max(160).optional(), group: identifier.optional() },
    { readOnly: true },
  ),
  ssh_host_create: operation(
    "Create an unapproved host profile. Credentials, routes and capabilities require local operator setup.",
    { profile: profileInput },
  ),
  ssh_host_update: operation(
    "Edit a profile at its expected revision. Only an operator can change endpoints, routes, credentials or file roots.",
    { ...target, ...revision, profile: profileInput },
  ),
  ssh_host_remove: operation(
    "Remove a host and invalidate its permissions and dependent connections.",
    { ...target, ...revision },
    { operator: true, destructive: true },
  ),
  ssh_hosts_export: operation(
    "Export profile metadata without credentials or host trust.",
    {},
    { readOnly: true },
  ),
  ssh_import_preview: operation(
    "Preview supported SSH configuration text. Never executes ProxyCommand, Includes or reads key files.",
    { text: z.string().max(1024 * 1024) },
    { readOnly: true },
  ),
  ssh_import_apply: operation(
    "Apply reviewed host import profiles without granting permissions.",
    { profiles: profileInput.array().max(256) },
    { operator: true },
  ),
  ssh_grants_get: operation(
    "Show human-granted capabilities for a target and its revision.",
    target,
    { readOnly: true },
  ),
  ssh_grants_set: operation(
    "Grant target capabilities after local human review. Shell grants arbitrary remote command execution.",
    { ...target, ...revision, capabilities },
    { operator: true, destructive: true },
  ),
  ssh_credentials_list: operation(
    "List credential references and metadata. Never returns secret values or key-file contents.",
    {},
    { readOnly: true },
  ),
  ssh_credential_add: operation(
    "Store an existing credential through trusted local operator setup.",
    {
      reference: z.discriminatedUnion("kind", [
        z.strictObject({
          name: z.string().max(160),
          kind: z.literal("agent"),
          socket: z.string().max(2048),
        }),
        z.strictObject({
          name: z.string().max(160),
          kind: z.literal("key-file"),
          path: z.string().max(2048),
          passphraseId: identifier.optional(),
        }),
        z.strictObject({
          name: z.string().max(160),
          kind: z.literal("vault"),
          secretKind: z.enum(["password", "private-key", "passphrase"]),
          passphraseId: identifier.optional(),
        }),
      ]),
      secret: z.strictObject({ value: secret, passphrase: secret.optional() }).optional(),
    },
    { operator: true },
  ),
  ssh_credential_remove: operation(
    "Remove an existing credential and invalidate its dependent connections and grants.",
    { credentialId: identifier },
    { operator: true, destructive: true },
  ),
  ssh_credential_update: operation(
    "Update a credential at its expected revision through trusted setup; invalidates dependent grants and connections.",
    {
      credentialId: identifier,
      ...revision,
      reference: credentialInput,
      secret: z.strictObject({ value: secret, passphrase: secret.optional() }).optional(),
    },
    { operator: true, destructive: true },
  ),
  ssh_vault_status: operation(
    "Report vault initialization and lock status without secrets.",
    {},
    { readOnly: true },
  ),
  ssh_vault_initialize: operation(
    "Initialize the authenticated encrypted local vault.",
    { password: secret },
    { operator: true },
  ),
  ssh_vault_unlock: operation(
    "Unlock the vault locally for new authentication and recording encryption.",
    { password: secret },
    { operator: true },
  ),
  ssh_vault_lock: operation(
    "Lock vault decryption while keeping existing authenticated SSH sessions usable.",
    {},
    { operator: true },
  ),
  ssh_vault_rotate: operation(
    "Rewrap the vault data key using a new password.",
    { previousPassword: secret, nextPassword: secret },
    { operator: true },
  ),
  ssh_vault_backup: operation(
    "Export encrypted vault records, including credential bytes only as authenticated ciphertext.",
    {},
    { operator: true, readOnly: true },
  ),
  ssh_vault_restore: operation(
    "Verify and restore an encrypted vault while retaining a local recovery backup.",
    { document: z.unknown(), password: secret },
    { operator: true, destructive: true },
  ),
  ssh_host_inspect: operation(
    "Inspect a target's presented SSH host key without accepting trust or authenticating the final target.",
    target,
    { operator: true, remote: true },
  ),
  ssh_host_confirm: operation(
    "Confirm the exact host key and fingerprint at the reviewed target revision; grants must be renewed afterwards.",
    { ...target, ...revision, key: z.string().max(32768), fingerprint: z.string().max(100) },
    { operator: true },
  ),
  ssh_host_revoke: operation(
    "Revoke locally confirmed host trust and invalidate grants and connections.",
    target,
    { operator: true, destructive: true },
  ),
  ssh_connections_list: operation(
    "List currently authorized reusable SSH connections.",
    {},
    { readOnly: true },
  ),
  ssh_connection_open: operation(
    "Open or reuse a verified authenticated connection for an explicitly approved target.",
    target,
    { remote: true },
  ),
  ssh_connection_probe: operation(
    "Check an approved target by completing verified SSH authentication without running a shell command.",
    target,
    { remote: true },
  ),
  ssh_connection_close: operation(
    "Close a connection, interrupting its plain PTYs and jobs; detached tmux may remain remotely.",
    { connectionId: identifier },
    { destructive: true, remote: true },
  ),
  ssh_connection_reconnect: operation(
    "Reconnect an approved target without replaying jobs or claiming plain PTY continuity.",
    target,
    { destructive: true, remote: true },
  ),
  ssh_sessions_list: operation(
    "List authorized terminal sessions with running, lost and tmux-recoverable states.",
    { targetId: identifier.optional() },
    { readOnly: true },
  ),
  ssh_session_create: operation(
    "Create a backend-owned PTY. Optional tmux requires an existing Unix installation; recording requires an unlocked vault.",
    {
      ...target,
      cols: size.cols.optional(),
      rows: size.rows.optional(),
      tmux: z.boolean().optional(),
      recording: z.boolean().optional(),
    },
    { remote: true },
  ),
  ssh_session_attach: operation(
    "Attach as an authenticated reader and receive a sequenced terminal snapshot or incremental output. Detects replay gaps.",
    { ...session, cursor },
  ),
  ssh_session_read: operation(
    "Read bounded sequenced terminal output after a cursor; a gap requires a fresh attach snapshot.",
    { ...session, cursor },
    { readOnly: true },
  ),
  ssh_session_detach: operation(
    "Detach this reader and release its input lease without ending the backend terminal.",
    session,
  ),
  ssh_session_writer: operation(
    "Acquire the single terminal input lease for this authenticated client. Agents cannot force a handoff.",
    { ...session, force: z.boolean().optional() },
  ),
  ssh_session_input: operation(
    "Send UTF-8 terminal input, including control characters, while holding the writer lease. Can execute arbitrary remote commands.",
    { ...session, data: z.string().max(16384) },
    { destructive: true, remote: true },
  ),
  ssh_session_resize: operation(
    "Resize a running PTY while holding its writer lease.",
    { ...session, ...size },
    { remote: true },
  ),
  ssh_session_close: operation(
    "End the attached terminal channel. Remote tmux processes may survive a channel close.",
    session,
    { destructive: true, remote: true },
  ),
  ssh_session_recover: operation(
    "Reattach a previously recoverable tmux session only after verified authentication and checking that it still exists.",
    session,
    { remote: true },
  ),
  ssh_session_recording: operation(
    "Read a bounded encrypted terminal recording after authorized vault decryption.",
    session,
    { readOnly: true },
  ),
  ssh_jobs_list: operation(
    "List retained jobs without replaying commands.",
    { targetId: identifier.optional() },
    { readOnly: true },
  ),
  ssh_job_start: operation(
    "Start an asynchronous arbitrary remote command on a shell-approved target; no command is automatically retried.",
    {
      ...target,
      command: z.string().min(1).max(65536),
      timeoutMs: z.number().int().min(100).max(86400000).optional(),
    },
    { destructive: true, remote: true },
  ),
  ssh_job_read: operation(
    "Read job status, exit result and bounded output. Unknown and cancelled outcomes do not prove remote descendants stopped.",
    { jobId: identifier, cursor },
    { readOnly: true },
  ),
  ssh_job_cancel: operation(
    "Close a job channel and request TERM when supported. Does not guarantee termination of detached remote descendants.",
    { jobId: identifier },
    { destructive: true, remote: true },
  ),
  ssh_group_run: operation(
    "Start a command across distinct explicit targets with bounded concurrency and individual permission/error results.",
    {
      targetIds: identifier.array().min(1).max(64),
      command: z.string().min(1).max(65536),
      timeoutMs: z.number().int().min(100).max(86400000).optional(),
    },
    { destructive: true, remote: true },
  ),
  ssh_files_list: operation(
    "List an approved SFTP directory within configured file roots.",
    remote,
    { readOnly: true, remote: true },
  ),
  ssh_file_stat: operation("Read SFTP file metadata within configured roots.", remote, {
    readOnly: true,
    remote: true,
  }),
  ssh_file_read: operation(
    "Read a maximum 64 KiB SFTP file range as base64; use streaming API for larger downloads.",
    {
      ...remote,
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(0).max(65536).optional(),
    },
    { readOnly: true, remote: true },
  ),
  ssh_file_write: operation(
    "Replace a small approved SFTP file from base64 data; use streaming API for larger uploads.",
    { ...remote, data: z.string().max(87384), mode: z.number().int().min(0).max(511).optional() },
    { destructive: true, remote: true },
  ),
  ssh_directory_create: operation(
    "Create one SFTP directory within configured roots.",
    { ...remote, mode: z.number().int().min(0).max(511).optional() },
    { remote: true },
  ),
  ssh_file_rename: operation(
    "Rename an approved SFTP path to another path within configured roots.",
    { ...remote, destination: z.string().max(2048) },
    { destructive: true, remote: true },
  ),
  ssh_file_remove: operation(
    "Remove an approved file or empty directory. Recursive deletion is not supported.",
    { ...remote, directory: z.boolean().optional() },
    { destructive: true, remote: true },
  ),
  ssh_file_chmod: operation(
    "Change ordinary SFTP permission bits within configured roots.",
    { ...remote, mode: z.number().int().min(0).max(511) },
    { destructive: true, remote: true },
  ),
  ssh_tunnels_list: operation(
    "List authorized local, remote and SOCKS tunnels and their interrupted states.",
    { targetId: identifier.optional() },
    { readOnly: true },
  ),
  ssh_tunnel_create: operation(
    "Create a loopback local/remote forward or SOCKS5 CONNECT tunnel on a tunnel-approved target.",
    {
      ...target,
      kind: z.enum(["local", "remote", "socks"]),
      listenPort: z.number().int().min(0).max(65535),
      destinationHost: endpoint.optional(),
      destinationPort: z.number().int().min(1).max(65535).optional(),
      reconnect: z.boolean().optional(),
    },
    { remote: true },
  ),
  ssh_tunnel_close: operation(
    "Close a tunnel and all its listeners and data channels.",
    { tunnelId: identifier },
    { destructive: true, remote: true },
  ),
  ssh_tunnel_reconnect: operation(
    "Explicitly reconnect an interrupted tunnel after checking current grants, credentials and trust.",
    { tunnelId: identifier },
    { remote: true },
  ),
  ssh_audit_read: operation(
    "Read bounded metadata-only audit events; commands, terminal output and credentials are excluded.",
    { cursor },
    { readOnly: true },
  ),
  ssh_diagnose: operation(
    "Report target configuration revision, capabilities, vault status and connection limits without credential values.",
    target,
    { readOnly: true },
  ),
} as const;
export type Operation = keyof typeof catalog;
export type OperationInputs = { [K in Operation]: z.input<(typeof catalog)[K]["schema"]> };
export { resultSchema } from "./outputs.js";
