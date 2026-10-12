import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fault, ManagementError, type OutputPage, type OutputPart } from "./contracts.js";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function privateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fault("UNSAFE_STATE", "State directory must be a real private directory.");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}
export function atomicJson(file: string, value: unknown) {
  const temp = path.join(path.dirname(file), `.write-${id()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function aborted(signal?: AbortSignal) {
  if (signal?.aborted) fault("CANCELLED", "Operation was cancelled.");
}
/** Every SSH channel request has a deadline independent of the authentication deadline. */
export function request<T>(
  start: (callback: (error?: Error | null, result?: T) => void) => void,
  timeout: number,
  signal?: AbortSignal,
  dispose?: (result: T) => void,
  setup?: (result: T) => void,
): Promise<T> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null, result?: T) => {
      if (settled) {
        if (result !== undefined) dispose?.(result);
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error)
        reject(
          error instanceof ManagementError
            ? error
            : new ManagementError("SSH_REQUEST_FAILED", "SSH request was rejected."),
        );
      else {
        try {
          setup?.(result as T);
          resolve(result as T);
        } catch (error) {
          if (result !== undefined) dispose?.(result);
          reject(error);
        }
      }
    };
    const cancel = () => finish(new ManagementError("CANCELLED", "Operation was cancelled."));
    const timer = setTimeout(
      () => finish(new ManagementError("TIMEOUT", "SSH channel request timed out.")),
      timeout,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      start(finish);
    } catch (error) {
      finish(error as Error);
    }
  });
}
export class OutputBuffer {
  private parts: OutputPart[] = [];
  private size = 0;
  private sequence = 0;
  private truncatedSequence = 0;
  private decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  constructor(readonly maximum: number) {}
  append(data: Buffer | string, stream: "stdout" | "stderr" = "stdout") {
    const text = typeof data === "string" ? data : this.decoders[stream].write(data);
    if (!text) return;
    const bytes = Buffer.from(text);
    // Keep entries small even when a single SSH packet exceeds the retention budget.
    const retained =
      bytes.length > this.maximum
        ? bytes.subarray(bytes.length - this.maximum).toString("utf8")
        : text;
    const part = { sequence: ++this.sequence, text: retained, stream };
    if (bytes.length > this.maximum) this.truncatedSequence = part.sequence;
    this.parts.push(part);
    this.size += Buffer.byteLength(retained);
    while (this.size > this.maximum && this.parts.length)
      this.size -= Buffer.byteLength(this.parts.shift()!.text);
    return part;
  }
  page(cursor = 0): OutputPage {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.sequence)
      fault("INVALID_CURSOR", "Output cursor is outside this stream.");
    return {
      parts: this.parts.filter((p) => p.sequence > cursor).map((p) => ({ ...p })),
      cursor: this.sequence,
      gap:
        cursor < this.truncatedSequence ||
        cursor < (this.parts[0]?.sequence ?? this.sequence + 1) - 1,
    };
  }
}
export function safeError(error: unknown) {
  return error instanceof ManagementError
    ? error
    : new ManagementError("INTERNAL", "Operation failed; inspect local metadata diagnostics.");
}
