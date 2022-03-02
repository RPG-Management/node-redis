import { EventEmitter } from "events";
import * as net from "net";
import * as tls from "tls";
import { encodeCommand } from "../commander";
import { RedisCommandArguments } from "../commands";
import { AuthError, ClientClosedError, ConnectionTimeoutError, ReconnectStrategyError, SocketClosedUnexpectedlyError } from "../errors";
import { promiseTimeout } from "../utils";

export interface RedisSocketCommonOptions {
  connectTimeout?: number;
  noDelay?: boolean;
  keepAlive?: number | false;

  reconnectStrategy?(retries: number): number | Error;
}

export interface RedisTlsSocketOptions extends tls.ConnectionOptions {
  tls?: boolean;
}

export interface RedisSocketOptions extends RedisSocketCommonOptions, RedisTlsSocketOptions {
  host?: string;
  port?: number;
  throwErrors?: boolean;
}

interface CreateSocketReturn<T> {
  connectEvent: string;
  socket: T;
}

export type RedisSocketInitiator = () => Promise<void>;

export default class RedisSocket extends EventEmitter {
  readonly #initiator?: RedisSocketInitiator;
  readonly #options: RedisSocketOptions;
  #socket?: net.Socket | tls.TLSSocket;
  #isOpen = false;
  #isReady = false;
  // https://nodejs.org/api/stream.html#stream_writable_writableneeddrain
  #writableNeedDrain = false;
  #isCorked = false;

  constructor(initiator?: RedisSocketInitiator, options?: RedisSocketOptions) {
    super();

    this.#initiator = initiator;
    this.#options = RedisSocket.#initiateOptions(options);

    console.log(`Initializing RedisSocket with options: ${JSON.stringify(this.#options)}`);
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  get isReady(): boolean {
    return this.#isReady;
  }

  // `writable.writableNeedDrain` was added in v15.2.0 and therefore can't be used

  get writableNeedDrain(): boolean {
    return this.#writableNeedDrain;
  }

  static #initiateOptions(options?: RedisSocketOptions): RedisSocketOptions {
    options ??= {};
    if (!(options as net.IpcSocketConnectOpts).path) {
      (options as net.TcpSocketConnectOpts).port ??= 6379;
      (options as net.TcpSocketConnectOpts).host ??= "localhost";
    }

    options.connectTimeout ??= 5000;
    options.keepAlive ??= 5000;
    options.noDelay ??= true;

    return options;
  }

  static #defaultReconnectStrategy(retries: number): number {
    return Math.min(retries * 50, 500);
  }

  static #isTlsSocket(options: RedisSocketOptions): options is RedisTlsSocketOptions {
    return (options as RedisTlsSocketOptions).tls as boolean;
  }

  async connect(): Promise<void> {
    if (this.#isOpen && this.#options.throwErrors) {
      throw new Error("Socket already opened");
    }

    return this.#connect();
  }

  writeCommand(args: RedisCommandArguments): void {
    if (!this.#socket) {
      this.emit("error", "Client closed");
      if (this.#options.throwErrors) throw new ClientClosedError();
    }

    for (const toWrite of encodeCommand(args)) {
      this.#writableNeedDrain = !this.#socket?.write(toWrite);
    }
  }

  disconnect(): void {
    if (!this.#socket) {
      this.emit("error", "Client closed");
      if (this.#options.throwErrors) throw new ClientClosedError();
    } else {
      this.#isOpen = this.#isReady = false;
    }

    this.#socket?.destroy();
    this.#socket = undefined;
    this.emit("end");
  }

  async quit(fn: () => Promise<unknown>): Promise<void> {
    if (!this.#isOpen) {
      this.emit("error", "Client closed");
      if (this.#options.throwErrors) throw new ClientClosedError();
    }

    this.#isOpen = false;
    await fn();
    this.disconnect();
  }

  cork(): void {
    if (!this.#socket || this.#isCorked) {
      return;
    }

    this.#socket.cork();
    this.#isCorked = true;

    queueMicrotask(() => {
      try {
        this.#socket?.uncork();
      } catch {
        /*ignore*/
      }
      this.#isCorked = false;
    });
  }

  async #connect(hadError?: boolean): Promise<void> {
    try {
      this.#isOpen = true;
      this.#socket = await this.#retryConnection(0, hadError);
      this.#writableNeedDrain = false;
    } catch (err) {
      this.#isOpen = false;
      console.log(`Error: ${err} (${this.#options.throwErrors})`);
      this.emit("error", err);
      this.emit("end");

      if (this.#options.throwErrors) {
        throw err;
      }
    }

    if (!this.#isOpen) {
      this.disconnect();
      return;
    }

    this.emit("connect");

    if (this.#initiator) {
      try {
        await this.#initiator();
      } catch (err) {
        this.#socket?.destroy();
        this.#socket = undefined;

        if (err instanceof AuthError) {
          this.#isOpen = false;
        }

        this.emit("error", err);
        this.emit("end");

        if (this.#options.throwErrors) {
          throw err;
        }
      }

      if (!this.#isOpen) return;
    }

    this.#isReady = true;

    this.emit("ready");
  }

  async #retryConnection(retries: number, hadError?: boolean): Promise<net.Socket | tls.TLSSocket> {
    console.log(`Redis: Retrying connection (${retries})`);

    if (retries > 0 || hadError) {
      this.emit("reconnect");
    }

    try {
      return await this.#createSocket();
    } catch (err) {
      console.log(`Caught error in retryConnection: ${err}`);

      if (!this.#isOpen && this.#options.throwErrors) {
        throw err;
      }

      const retryIn = (this.#options?.reconnectStrategy ?? RedisSocket.#defaultReconnectStrategy)(retries);
      if (retryIn instanceof Error) {
        this.emit("error", err);
        if (this.#options.throwErrors) throw new ReconnectStrategyError(retryIn, err);
      }

      this.emit("error", err);
      await promiseTimeout(retryIn as number);
      return await this.#retryConnection(retries + 1);
    }
  }

  #createSocket(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const { connectEvent, socket } = RedisSocket.#isTlsSocket(this.#options) ? this.#createTlsSocket() : this.#createNetSocket();

      if (this.#options.connectTimeout) {
        socket.setTimeout(this.#options.connectTimeout, () => {
          this.emit("error", "Connection timeout");
          return socket.destroy(this.#options.throwErrors ? new ConnectionTimeoutError() : undefined);
        });
      }

      socket
        .setNoDelay(this.#options.noDelay)
        .setKeepAlive(this.#options.keepAlive !== false, this.#options.keepAlive || 0)
        .once("error", reject)
        .once(connectEvent, () => {
          socket
            .setTimeout(0)
            .off("error", reject)
            .once("error", (err: Error) => this.#onSocketError(err))
            .once("close", (hadError) => {
              if (!hadError && this.#isOpen && this.#socket === socket) {
                this.emit("error", "Connection closed");
                if (this.#options.throwErrors) this.#onSocketError(new SocketClosedUnexpectedlyError());
              }
            })
            .on("drain", () => {
              this.#writableNeedDrain = false;
              this.emit("drain");
            })
            .on("data", (data: Buffer) => this.emit("data", data));

          console.log(`Redis: Reconnected`);
          this.emit("connect");
          resolve(socket);
        });
    });
  }

  #createNetSocket(): CreateSocketReturn<net.Socket> {
    return {
      connectEvent: "connect",
      socket: net.connect(this.#options as net.NetConnectOpts), // TODO
    };
  }

  #createTlsSocket(): CreateSocketReturn<tls.TLSSocket> {
    return {
      connectEvent: "secureConnect",
      socket: tls.connect(this.#options as tls.ConnectionOptions), // TODO
    };
  }

  #onSocketError(err: Error): void {
    this.#isReady = false;
    this.emit("error", err);

    this.#connect(true).catch(() => {
      // the error was already emitted, silently ignore it
    });
  }
}
