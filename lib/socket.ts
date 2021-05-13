import EventEmitter from 'events';
import net from 'net';
import tls from 'tls';
import { setTimeout } from 'timers/promises';

interface RedisSocketCommonOptions {
    username?: string;
    password?: string;
    retryStrategy?(retries: number): number | Error;
}

interface RedisNetSocketOptions extends RedisSocketCommonOptions {
    port?: number;
    host?: string;
}

interface RedisUrlSocketOptions extends RedisSocketCommonOptions {
    url: string;
}

interface RedisUnixSocketOptions extends RedisSocketCommonOptions {
    path: string;
}

interface RedisTlsSocketOptions extends RedisNetSocketOptions {
    tls: tls.SecureContextOptions;
}

export type RedisSocketOptions = RedisNetSocketOptions | RedisUrlSocketOptions | RedisUnixSocketOptions | RedisTlsSocketOptions;

interface CreateSocketReturn<T> {
    connectEvent: string;
    socket: T;
}

export type RedisSocketInitiator = () => Promise<void>;

export default class RedisSocket extends EventEmitter {
    static #initiateOptions(options?: RedisSocketOptions): RedisSocketOptions {
        options ??= {};
        if (!RedisSocket.#isUnixSocket(options)) {
            if (RedisSocket.#isUrlSocket(options)) {
                const url = new URL(options.url);
                (options as RedisNetSocketOptions).port = Number(url.port);
                (options as RedisNetSocketOptions).host = url.hostname;
                options.username = url.username;
                options.password = url.password;
            }

            (options as RedisNetSocketOptions).port ??= 6379;
            (options as RedisNetSocketOptions).host ??= '127.0.0.1';
        }

        return options;
    }

    static #defaultRetryStrategy(retries: number): number {
        return Math.min(retries * 50, 500);
    }

    static #isUrlSocket(options: RedisSocketOptions): options is RedisUrlSocketOptions {
        return options.hasOwnProperty('url');
    }

    static #isUnixSocket(options: RedisSocketOptions): options is RedisUnixSocketOptions {
        return options.hasOwnProperty('path');
    }

    static #isTlsSocket(options: RedisSocketOptions): options is RedisTlsSocketOptions {
        return options.hasOwnProperty('tls');
    }

    readonly #initiator?: RedisSocketInitiator;

    readonly #options: RedisSocketOptions;

    #socket?: net.Socket | tls.TLSSocket;

    #isOpen = false;

    get isOpen(): boolean {
        return this.#isOpen;
    }

    get chunkRecommendedSize(): number {
        if (!this.#socket) return 0;

        return this.#socket.writableHighWaterMark - this.#socket.writableLength;
    }

    constructor(initiator?: RedisSocketInitiator, options?: RedisSocketOptions) {
        super();

        this.#initiator = initiator;
        this.#options = RedisSocket.#initiateOptions(options);
    }

    async connect(): Promise<void> {
        if (this.#isOpen) {
            throw new Error('Socket is connection/connecting');
        }

        this.#isOpen = true;
        this.#socket = await this.#retryConnection(0);
        this.emit('connect');

        if (!this.#initiator) return;

        try {
            await this.#initiator();
            this.emit('ready');
        } catch (err) {
            this.#isOpen = false;
            this.#socket.end();
            this.#socket = undefined;
            throw err;
        }
    }

    async #retryConnection(retries: number): Promise<net.Socket | tls.TLSSocket> {
        if (retries > 0 || this.#socket) {
            this.emit('reconnecting');
        }

        try {
            return await this.#createSocket();
        } catch (err) {
            this.emit('error', err);

            if (!this.#isOpen) {
                throw err;
            }

            const retryIn = (this.#options?.retryStrategy ?? RedisSocket.#defaultRetryStrategy)(retries);
            if (retryIn instanceof Error) {
                throw retryIn;
            }

            await setTimeout(retryIn);
            return this.#retryConnection(retries + 1);
        }
    }

    #createSocket(): Promise<net.Socket | tls.TLSSocket> {
        return new Promise((resolve, reject) => {
            const {connectEvent, socket} = RedisSocket.#isTlsSocket(this.#options) ?
                this.#createTlsSocket() :
                this.#createNetSocket();

            socket
                .once('error', reject)
                .once(connectEvent, () => {
                    socket
                        .off('error', reject)
                        .once('error', (err: Error) => this.#onSocketError(err))
                        .once('end', () => {
                            this.emit('end');

                            if (this.#isOpen) {
                                this.#onSocketError(new Error('Socket ended'));
                            }
                        })
                        .on('drain', () => this.emit('drain'))
                        .on('data', (data: Buffer) => this.emit('data', data));

                    resolve(socket);
                });
        });
    }

    #createNetSocket(): CreateSocketReturn<net.Socket> {
        return {
            connectEvent: 'connect',
            socket: net.connect(this.#options as net.NetConnectOpts) // TODO
        };
    }

    #createTlsSocket(): CreateSocketReturn<tls.TLSSocket> {
        return {
            connectEvent: 'secureConnect',
            socket: tls.connect(this.#options as tls.ConnectionOptions) // TODO
        };
    }

    #onSocketError(err: Error): void {
        this.emit('error', err);

        this.#retryConnection(0).catch(err => {
            this.emit('error', err);
            this.#socket = undefined;
        });
    }

    write(encodedCommands: string): boolean {
        if (!this.#socket) {
            throw new Error('Socket is closed');
        }

        return this.#socket.write(encodedCommands);
    }

    async disconnect(): Promise<void> {
        if (!this.#isOpen || !this.#socket) {
            throw new Error('Socket is closed');
        }

        this.#isOpen = false;
        this.#socket.end();
        await EventEmitter.once(this.#socket, 'end');
        this.#socket = undefined;
    }
}