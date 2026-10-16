import type { Readable } from "node:stream";
import type {
  Actor,
  SessionInfo,
  JobInfo,
  OutputPage,
  TunnelInput,
  TunnelInfo,
} from "./contracts.js";

export type SessionOptions = {
  cols?: number;
  rows?: number;
  tmux?: boolean;
  recording?: boolean;
  signal?: AbortSignal;
};
export type SessionSnapshot = {
  session: SessionInfo;
  snapshot: string;
  cursor: number;
  output: OutputPage;
  recordingPaused: boolean;
};
export interface SessionReaderLease {
  readonly snapshot: Promise<SessionSnapshot>;
  /** Idempotent exact-reader cleanup; cannot detach a replacement attachment. */
  detach(): void;
}
export interface SessionAPI {
  create(actor: Actor, targetId: string, options?: SessionOptions): Promise<SessionInfo>;
  attach(actor: Actor, sessionId: string, cursor?: number): Promise<SessionSnapshot>;
  attachWithCleanup(actor: Actor, sessionId: string, cursor?: number): SessionReaderLease;
  read(
    actor: Actor,
    sessionId: string,
    cursor?: number,
  ): { session: SessionInfo; output: OutputPage };
  detach(actor: Actor, sessionId: string): SessionInfo;
  writer(actor: Actor, sessionId: string, force?: boolean): SessionInfo;
  input(actor: Actor, sessionId: string, data: string): { accepted: number };
  resize(actor: Actor, sessionId: string, cols: number, rows: number): SessionInfo;
  close(actor: Actor, sessionId: string): SessionInfo;
  recover(actor: Actor, sessionId: string, signal?: AbortSignal): Promise<SessionInfo>;
  recording(actor: Actor, sessionId: string): { text: string };
  list(actor: Actor, targetId?: string): SessionInfo[];
}
export type JobOptions = { signal?: AbortSignal; timeout?: number };
export type JobResult = { job: JobInfo; output: OutputPage; remoteTerminationConfirmed: boolean };
export type GroupResult = {
  targetId: string;
  job?: JobInfo;
  error?: { code: string; message: string };
};
export interface JobAPI {
  start(actor: Actor, targetId: string, command: string, options?: JobOptions): Promise<JobInfo>;
  read(actor: Actor, jobId: string, cursor?: number): JobResult;
  list(actor: Actor, targetId?: string): JobInfo[];
  cancel(actor: Actor, jobId: string): JobInfo & { remoteTerminationConfirmed: boolean };
  group(
    actor: Actor,
    targets: string[],
    command: string,
    options?: JobOptions,
  ): Promise<GroupResult[]>;
}
export type FileMetadata = {
  size: number;
  mode: number;
  uid: number;
  gid: number;
  atime: number;
  mtime: number;
  directory: boolean;
  file: boolean;
  symlink: boolean;
};
export type TransferOptions = { signal?: AbortSignal; progress?: (bytes: number) => void };
export interface FileAPI {
  list(
    actor: Actor,
    targetId: string,
    remote: string,
    signal?: AbortSignal,
  ): Promise<(FileMetadata & { name: string })[]>;
  stat(actor: Actor, targetId: string, remote: string, signal?: AbortSignal): Promise<FileMetadata>;
  mutate(
    actor: Actor,
    targetId: string,
    operation: "mkdir" | "rename" | "remove" | "chmod",
    remote: string,
    options?: { destination?: string; mode?: number; directory?: boolean; signal?: AbortSignal },
  ): Promise<{ completed: boolean }>;
  download(
    actor: Actor,
    targetId: string,
    remote: string,
    options?: TransferOptions & { offset?: number; length?: number },
  ): Promise<Readable>;
  upload(
    actor: Actor,
    targetId: string,
    remote: string,
    input: Readable,
    options?: TransferOptions & { mode?: number },
  ): Promise<{ completed: boolean }>;
  read(
    actor: Actor,
    targetId: string,
    remote: string,
    offset?: number,
    length?: number,
    signal?: AbortSignal,
  ): Promise<{ data: string; encoding: "base64"; offset: number; bytes: number }>;
}
export interface TunnelAPI {
  create(
    actor: Actor,
    targetId: string,
    input: TunnelInput,
    signal?: AbortSignal,
  ): Promise<TunnelInfo>;
  list(actor: Actor, targetId?: string): TunnelInfo[];
  close(actor: Actor, tunnelId: string): Promise<TunnelInfo>;
  reconnect(actor: Actor, tunnelId: string, signal?: AbortSignal): Promise<TunnelInfo>;
}
