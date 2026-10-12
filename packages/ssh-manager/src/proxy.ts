import net from "node:net";
import { fault, ManagementError } from "./contracts.js";
import { aborted } from "./util.js";

export function connectSocket(
  host: string,
  port: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<net.Socket> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let done = false;
    const timer = setTimeout(
      () => finish(new ManagementError("TIMEOUT", "Network connection timed out.")),
      timeout,
    );
    const cancel = () =>
      finish(new ManagementError("CANCELLED", "Network connection was cancelled."));
    function finish(error?: Error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    }
    socket.on("error", () =>
      finish(new ManagementError("CONNECTION_FAILED", "Network connection failed.")),
    );
    socket.once("connect", () => finish());
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
/** Bounded handshake reader. Hand leftover bytes back to the subsequent SSH/data protocol. */
export class SocketReader {
  private deadline: number;
  private buffer = Buffer.alloc(0);
  private waiter?: () => void;
  private ended = false;
  private onData = (data: Buffer) => {
    if (this.buffer.length + data.length > 65536) {
      this.ended = true;
      this.socket.destroy();
    } else this.buffer = Buffer.concat([this.buffer, data]);
    this.waiter?.();
  };
  private onEnd = () => {
    this.ended = true;
    this.waiter?.();
  };
  constructor(
    private socket: net.Socket,
    private timeout: number,
    private signal?: AbortSignal,
  ) {
    this.deadline = Date.now() + timeout;
    socket.on("data", this.onData);
    socket.on("close", this.onEnd);
    socket.on("error", this.onEnd);
  }
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      aborted(this.signal);
      if (this.ended) fault("PROXY_FAILED", "Proxy closed during its handshake.");
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) fault("TIMEOUT", "Proxy handshake timed out.");
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          this.signal?.removeEventListener("abort", cancel);
          this.waiter = undefined;
          error ? reject(error) : resolve();
        };
        const cancel = () => finish(new ManagementError("CANCELLED", "Proxy handshake cancelled."));
        const timer = setTimeout(
          () => finish(new ManagementError("TIMEOUT", "Proxy handshake timed out.")),
          remaining,
        );
        this.waiter = () => finish();
        this.signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }
  async line() {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < 8192) {
      const byte = await this.read(1);
      chunks.push(byte);
      length++;
      if (byte[0] === 10) return Buffer.concat(chunks).toString("ascii");
    }
    fault("PROXY_FAILED", "Proxy response line is too long.");
  }
  release() {
    this.socket.pause();
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onEnd);
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}
export function socksAddress(host: string) {
  if (net.isIP(host) === 4) return Buffer.from([1, ...host.split(".").map(Number)]);
  // Domain form also supports textual IPv6 without a second DNS lookup in this process.
  const bytes = Buffer.from(host);
  if (bytes.length > 255) fault("INVALID_ARGUMENT", "SOCKS target name is too long.");
  return Buffer.concat([Buffer.from([3, bytes.length]), bytes]);
}
async function readSocksHost(reader: SocketReader, type: number) {
  if (type === 1) return [...(await reader.read(4))].join(".");
  if (type === 3) return (await reader.read((await reader.read(1))[0]!)).toString("utf8");
  if (type === 4) {
    const bytes = await reader.read(16);
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    return groups.join(":");
  }
  fault("PROXY_FAILED", "Unsupported SOCKS address type.");
}
export async function proxySocket(
  proxy: { kind: "socks5" | "http-connect"; host: string; port: number; username?: string },
  host: string,
  port: number,
  timeout: number,
  signal?: AbortSignal,
  password?: string,
) {
  const socket = await connectSocket(proxy.host, proxy.port, timeout, signal);
  const reader = new SocketReader(socket, timeout, signal);
  try {
    if (proxy.kind === "http-connect") {
      const authority = `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
      const auth =
        password !== undefined
          ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username ?? ""}:${password}`).toString("base64")}\r\n`
          : "";
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
      const status = await reader.line();
      if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(status))
        fault("PROXY_FAILED", "HTTP proxy rejected CONNECT.");
      let total = status.length;
      while (true) {
        const line = await reader.line();
        total += line.length;
        if (total > 32768) fault("LIMIT", "Proxy headers exceed their limit.");
        if (line === "\r\n") break;
      }
    } else {
      const authenticate = password !== undefined;
      socket.write(Buffer.from([5, 1, authenticate ? 2 : 0]));
      const greeting = await reader.read(2);
      if (greeting[0] !== 5 || greeting[1] !== (authenticate ? 2 : 0))
        fault("PROXY_FAILED", "SOCKS proxy rejected authentication negotiation.");
      if (authenticate) {
        const user = Buffer.from(proxy.username ?? ""),
          pass = Buffer.from(password!);
        if (user.length > 255 || pass.length > 255)
          fault("INVALID_CREDENTIAL", "SOCKS authentication value is too long.");
        socket.write(
          Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]),
        );
        if ((await reader.read(2))[1] !== 0)
          fault("PROXY_FAILED", "SOCKS proxy rejected authentication.");
      }
      const destinationPort = Buffer.alloc(2);
      destinationPort.writeUInt16BE(port);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host), destinationPort]));
      const reply = await reader.read(4);
      if (reply[0] !== 5 || reply[1] !== 0) fault("PROXY_FAILED", "SOCKS proxy rejected CONNECT.");
      await readSocksHost(reader, reply[3]!);
      await reader.read(2);
    }
    reader.release();
    return socket;
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}
export async function acceptSocks(socket: net.Socket, timeout: number) {
  const reader = new SocketReader(socket, timeout);
  try {
    const header = await reader.read(2);
    if (header[0] !== 5 || !header[1]) fault("PROXY_FAILED", "SOCKS5 is required.");
    const methods = await reader.read(header[1]);
    if (!methods.includes(0)) {
      socket.write(Buffer.from([5, 255]));
      fault("PROXY_FAILED", "SOCKS method unsupported.");
    }
    socket.write(Buffer.from([5, 0]));
    const request = await reader.read(4);
    if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0)
      fault("PROXY_FAILED", "Only SOCKS CONNECT is supported.");
    const host = await readSocksHost(reader, request[3]!);
    const port = (await reader.read(2)).readUInt16BE();
    reader.release();
    return { host, port };
  } catch (error) {
    reader.release();
    throw error;
  }
}
