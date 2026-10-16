import { Writable, finished, type Readable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { deserializeMessage, type Transport } from "@modelcontextprotocol/server";

/**
 * Keep the official SDK framing/decoder and join the real Writable callback.
 * SDK 2.3.1 send() otherwise finishes on write acceptance/drain alone.
 * The canonical entry serializes sends, including this callback join.
 */
export function createManagementStdioTransport(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  maxBufferSize = 1048576,
): Transport {
  let writing: Promise<void> = Promise.resolve();
  let sends: Promise<void> = Promise.resolve();
  const sink = new Writable({
    write(chunk, encoding, callback) {
      writing = new Promise<void>((resolve, reject) => {
        try {
          output.write(chunk, encoding, (error) => {
            callback(error);
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          callback(error as Error);
          reject(error);
        }
      });
      // SDK send may reject before the physical callback; the owner still joins it.
      void writing.catch(() => {});
    },
  });
  const wire = new StdioServerTransport(input, sink, { maxBufferSize });
  // SDK 2.3.1's ReadBuffer silently skips JSON syntax errors. Inspect bounded
  // lines with its public decoder before dispatch so those errors also fail closed.
  // StdioServerTransport still owns all protocol framing and message delivery.
  let pendingInput: Buffer = Buffer.alloc(0);
  let inputFailed = false;
  const rejectInput = () => {
    if (inputFailed) return;
    inputFailed = true;
    pendingInput = Buffer.alloc(0);
    try {
      transport.onerror?.(new Error("Invalid MCP input frame."));
    } finally {
      void transport.close().catch(() => {});
    }
  };
  const inspectInput = (chunk: Buffer | string) => {
    if (inputFailed) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (pendingInput.length + bytes.length > maxBufferSize) {
        rejectInput();
        return;
      }
      pendingInput = pendingInput.length ? Buffer.concat([pendingInput, bytes]) : bytes;
      let newline: number;
      while ((newline = pendingInput.indexOf("\n")) !== -1) {
        deserializeMessage(pendingInput.toString("utf8", 0, newline).replace(/\r$/, ""));
        pendingInput = pendingInput.subarray(newline + 1);
      }
    } catch {
      rejectInput();
    }
  };
  const inspectEnd = () => {
    if (pendingInput.length) rejectInput();
  };
  const outputError = (error: Error) => sink.destroy(error);
  let outputSettled: Promise<void> | undefined;
  let unobserveOutput: (() => void) | undefined;
  const observeOutput = () =>
    (outputSettled ??= new Promise<void>((resolve) => {
      // Must be attached BEFORE failure: late finished() can report a cached
      // error while an emitClose:false Writable still owns asynchronous destroy.
      unobserveOutput = finished(output, { readable: false }, () => resolve());
    }));
  const settleOutput = async () => {
    // Node schedules errors after the write callback. An asynchronous _destroy
    // can outlive that turn: only its actual close completes the failed stream.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (output.destroyed && !output.closed) await outputSettled;
  };
  const transport: Transport = {
    start: async () => {
      output.on("error", outputError);
      observeOutput();
      wire.onmessage = (message) => {
        if (!inputFailed) transport.onmessage?.(message);
      };
      wire.onerror = (error) => transport.onerror?.(error);
      wire.onclose = () => transport.onclose?.();
      input.on("data", inspectInput);
      input.on("end", inspectEnd);
      await wire.start();
    },
    send: (message) => {
      observeOutput();
      const done = sends.then(async () => {
        const sent = wire.send(message);
        // write() enters the sink synchronously. Serializing here also protects
        // direct Transport consumers from capturing a previous callback's tail.
        const result = await Promise.allSettled([sent, writing]);
        for (const item of result)
          if (item.status === "rejected") {
            await settleOutput();
            throw item.reason;
          }
      });
      sends = done.catch(() => {});
      return done;
    },
    close: async () => {
      try {
        input.off("data", inspectInput);
        input.off("end", inspectEnd);
        pendingInput = Buffer.alloc(0);
        await wire.close();
        await sends;
        await writing;
      } finally {
        await settleOutput();
        unobserveOutput?.();
        output.off("error", outputError);
      }
    },
  };
  return transport;
}
