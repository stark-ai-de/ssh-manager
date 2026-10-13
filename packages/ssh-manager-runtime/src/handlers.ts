import { Readable } from "node:stream";
import type { SSHManager, Actor } from "@stark-ai/ssh-manager";
import type { OperationInputs, Operation } from "./catalog.js";
import type { OperationResultInputs } from "./outputs.js";
type Arg<K extends Operation> = OperationInputs[K];
export type OperationHandlers = {
  [K in Operation]: (a: Arg<K>) => OperationResultInputs[K] | Promise<OperationResultInputs[K]>;
};
export function handlers(manager: SSHManager, actor: Actor, signal?: AbortSignal) {
  return {
    ssh_hosts_list: (a: Arg<"ssh_hosts_list">) => manager.profiles(actor, a),
    ssh_host_create: (a: Arg<"ssh_host_create">) => manager.createProfile(actor, a.profile),
    ssh_host_update: (a: Arg<"ssh_host_update">) =>
      manager.updateProfile(actor, a.targetId, a.expectedRevision, a.profile),
    ssh_host_remove: (a: Arg<"ssh_host_remove">) =>
      manager.removeProfile(actor, a.targetId, a.expectedRevision),
    ssh_hosts_export: (_a: Arg<"ssh_hosts_export">) => manager.exportProfiles(actor),
    ssh_import_preview: (a: Arg<"ssh_import_preview">) => manager.previewImport(actor, a.text),
    ssh_import_apply: (a: Arg<"ssh_import_apply">) => manager.applyImport(actor, a.profiles),
    ssh_grants_get: (a: Arg<"ssh_grants_get">) => manager.grants(actor, a.targetId),
    ssh_grants_set: (a: Arg<"ssh_grants_set">) =>
      manager.setGrants(actor, a.targetId, a.expectedRevision, a.capabilities),
    ssh_credentials_list: (_a: Arg<"ssh_credentials_list">) => manager.credentials(actor),
    ssh_credential_add: (a: Arg<"ssh_credential_add">) =>
      manager.addCredential(actor, a.reference, a.secret),
    ssh_credential_remove: (a: Arg<"ssh_credential_remove">) =>
      manager.removeCredential(actor, a.credentialId),
    ssh_credential_update: (a: Arg<"ssh_credential_update">) =>
      manager.updateCredential(actor, a.credentialId, a.expectedRevision, a.reference, a.secret),
    ssh_vault_status: (_a: Arg<"ssh_vault_status">) => manager.vaultStatus(actor),
    ssh_vault_initialize: (a: Arg<"ssh_vault_initialize">) =>
      manager.vaultInitialize(actor, a.password),
    ssh_vault_unlock: (a: Arg<"ssh_vault_unlock">) => manager.vaultUnlock(actor, a.password),
    ssh_vault_lock: (_a: Arg<"ssh_vault_lock">) => manager.vaultLock(actor),
    ssh_vault_rotate: (a: Arg<"ssh_vault_rotate">) =>
      manager.vaultRotate(actor, a.previousPassword, a.nextPassword),
    ssh_vault_backup: (_a: Arg<"ssh_vault_backup">) => manager.vaultBackup(actor),
    ssh_vault_restore: (a: Arg<"ssh_vault_restore">) =>
      manager.vaultRestore(actor, a.document, a.password),
    ssh_host_inspect: (a: Arg<"ssh_host_inspect">) =>
      manager.inspectHost(actor, a.targetId, signal),
    ssh_host_confirm: (a: Arg<"ssh_host_confirm">) =>
      manager.confirmHost(actor, a.targetId, a.expectedRevision, a.key, a.fingerprint),
    ssh_host_revoke: (a: Arg<"ssh_host_revoke">) => manager.revokeHost(actor, a.targetId),
    ssh_connections_list: (_a: Arg<"ssh_connections_list">) => manager.connections(actor),
    ssh_connection_open: (a: Arg<"ssh_connection_open">) =>
      manager.openConnection(actor, a.targetId, signal),
    ssh_connection_probe: (a: Arg<"ssh_connection_probe">) =>
      manager.openConnection(actor, a.targetId, signal),
    ssh_connection_close: (a: Arg<"ssh_connection_close">) =>
      manager.closeConnection(actor, a.connectionId),
    ssh_connection_reconnect: (a: Arg<"ssh_connection_reconnect">) =>
      manager.reconnect(actor, a.targetId, signal),
    ssh_sessions_list: (a: Arg<"ssh_sessions_list">) => manager.sessions.list(actor, a.targetId),
    ssh_session_create: (a: Arg<"ssh_session_create">) =>
      manager.sessions.create(actor, a.targetId, { ...a, signal }),
    ssh_session_attach: (a: Arg<"ssh_session_attach">) =>
      manager.sessions.attach(actor, a.sessionId, a.cursor),
    ssh_session_read: (a: Arg<"ssh_session_read">) =>
      manager.sessions.read(actor, a.sessionId, a.cursor),
    ssh_session_detach: (a: Arg<"ssh_session_detach">) =>
      manager.sessions.detach(actor, a.sessionId),
    ssh_session_writer: (a: Arg<"ssh_session_writer">) =>
      manager.sessions.writer(actor, a.sessionId, a.force),
    ssh_session_input: (a: Arg<"ssh_session_input">) =>
      manager.sessions.input(actor, a.sessionId, a.data),
    ssh_session_resize: (a: Arg<"ssh_session_resize">) =>
      manager.sessions.resize(actor, a.sessionId, a.cols, a.rows),
    ssh_session_close: (a: Arg<"ssh_session_close">) => manager.sessions.close(actor, a.sessionId),
    ssh_session_recover: (a: Arg<"ssh_session_recover">) =>
      manager.sessions.recover(actor, a.sessionId, signal),
    ssh_session_recording: (a: Arg<"ssh_session_recording">) =>
      manager.sessions.recording(actor, a.sessionId),
    ssh_jobs_list: (a: Arg<"ssh_jobs_list">) => manager.jobs.list(actor, a.targetId),
    ssh_job_start: (a: Arg<"ssh_job_start">) =>
      manager.jobs.start(actor, a.targetId, a.command, { signal, timeout: a.timeoutMs }),
    ssh_job_read: (a: Arg<"ssh_job_read">) => manager.jobs.read(actor, a.jobId, a.cursor),
    ssh_job_cancel: (a: Arg<"ssh_job_cancel">) => manager.jobs.cancel(actor, a.jobId),
    ssh_group_run: (a: Arg<"ssh_group_run">) =>
      manager.jobs.group(actor, a.targetIds, a.command, { signal, timeout: a.timeoutMs }),
    ssh_files_list: (a: Arg<"ssh_files_list">) =>
      manager.files.list(actor, a.targetId, a.path, signal),
    ssh_file_stat: (a: Arg<"ssh_file_stat">) =>
      manager.files.stat(actor, a.targetId, a.path, signal),
    ssh_file_read: (a: Arg<"ssh_file_read">) =>
      manager.files.read(actor, a.targetId, a.path, a.offset, a.length, signal),
    ssh_file_write: (a: Arg<"ssh_file_write">) =>
      manager.files.upload(
        actor,
        a.targetId,
        a.path,
        Readable.from(Buffer.from(a.data, "base64")),
        { signal, mode: a.mode },
      ),
    ssh_directory_create: (a: Arg<"ssh_directory_create">) =>
      manager.files.mutate(actor, a.targetId, "mkdir", a.path, { ...a, signal }),
    ssh_file_rename: (a: Arg<"ssh_file_rename">) =>
      manager.files.mutate(actor, a.targetId, "rename", a.path, { ...a, signal }),
    ssh_file_remove: (a: Arg<"ssh_file_remove">) =>
      manager.files.mutate(actor, a.targetId, "remove", a.path, { ...a, signal }),
    ssh_file_chmod: (a: Arg<"ssh_file_chmod">) =>
      manager.files.mutate(actor, a.targetId, "chmod", a.path, { ...a, signal }),
    ssh_tunnels_list: (a: Arg<"ssh_tunnels_list">) => manager.tunnels.list(actor, a.targetId),
    ssh_tunnel_create: (a: Arg<"ssh_tunnel_create">) =>
      manager.tunnels.create(actor, a.targetId, a, signal),
    ssh_tunnel_close: (a: Arg<"ssh_tunnel_close">) => manager.tunnels.close(actor, a.tunnelId),
    ssh_tunnel_reconnect: (a: Arg<"ssh_tunnel_reconnect">) =>
      manager.tunnels.reconnect(actor, a.tunnelId, signal),
    ssh_audit_read: (a: Arg<"ssh_audit_read">) => manager.audit(actor, a.cursor),
    ssh_diagnose: (a: Arg<"ssh_diagnose">) => manager.diagnose(actor, a.targetId),
  } satisfies OperationHandlers;
}
export type { OperationResults } from "./outputs.js";
