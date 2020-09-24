import * as net from "net";
import sequid from "sequid";
import { exponential, Backoff } from "backoff";
import { decompose } from "@hyurl/structured-clone";
import isSocketResetError = require('is-socket-reset-error');
import { ThenableAsyncGenerator, ThenableAsyncGeneratorLike } from 'thenable-generator';
import { RpcChannel, RpcEvents, RpcOptions, Response, Request } from "./channel";
import { ModuleProxy as ModuleProxyBase } from "../proxy";
import { ModuleProxy as ModuleProxyRoot } from "..";
import {
    createRemoteInstance,
    humanizeDuration,
    throwUnavailableError,
    readyState,
    dict,
    proxyRoot
} from "../util";
import last = require("lodash/last");
import isOwnKey from "@hyurl/utils/isOwnKey";

type Subscriber = (data: any) => void | Promise<void>;
type ChannelState = "initiated" | "connecting" | "connected" | "closed";
type Task = {
    resolve: (data: any) => void,
    reject: (err: Error) => void;
};

export interface ClientOptions extends RpcOptions {
    timeout?: number;
    pingInterval?: number;
    serverId?: string;
}

export class RpcClient extends RpcChannel implements ClientOptions {
    /** The unique ID of the client, used for the server publishing topics. */
    readonly id: string;
    readonly timeout: number;
    readonly pingInterval: number;
    serverId: string;
    protected state: ChannelState = "initiated";
    protected socket: net.Socket = null;
    protected registry: { [name: string]: ModuleProxy<any>; } = dict();
    protected taskId = sequid(0, true);
    protected tasks = new Map<number, Task>();
    protected topics = new Map<string, Set<Subscriber>>();
    protected finishConnect: Function = null;
    protected rejectConnect: Function = null;
    private lastActiveTime: number = Date.now();
    protected selfDestruction: NodeJS.Timer = null;
    protected pingTimer: NodeJS.Timer = null;
    private reconnect: Backoff = null;

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: ClientOptions);
    constructor(options: string | number | ClientOptions, host?: string) {
        super(<any>options, host);
        this.id = this.id || Math.random().toString(16).slice(2);
        this.timeout = this.timeout || 5000;
        this.pingInterval = this.pingInterval || 5000;
        this.serverId = this.serverId || this.dsn;
    }

    /** Whether the channel is in connecting state. */
    get connecting() {
        return this.state === "connecting";
    }
    /** Whether the channel is connected. */
    get connected() {
        return this.state === "connected";
    }
    /** Whether the channel is closed. */
    get closed() {
        return this.state === "closed";
    };

    open(): Promise<this> {
        return new Promise((resolve, reject) => {
            let { serverId } = this;

            if (this.socket && this.socket.connecting) {
                throw new Error(`Channel to ${serverId} is already open`);
            } else if (this.closed) {
                throw new Error(
                    `Cannot reconnect to ${serverId} after closing the channel`
                );
            }

            this.state === "connecting";
            this.finishConnect = () => {
                this.state = "connected";
                this.resume();

                if (!this.pingTimer && !this.reconnect) {
                    this.setPingAndReconnectTimer(serverId);
                }

                resolve(this);
            };
            this.rejectConnect = () => {
                reject(new Error(`Unable to connect ${serverId}`));
            };

            let timer = setTimeout(this.rejectConnect, this.timeout);
            let connectListener = () => {
                clearTimeout(timer);
                this.socket.removeListener("error", errorListener);
                this.prepareChannel();

                if (this.secret) {
                    // Sending the connection secret before hitting handshaking.
                    this.socket.write(this.secret, () => {
                        this.send(RpcEvents.HANDSHAKE, this.id);
                    });
                } else {
                    this.send(RpcEvents.HANDSHAKE, this.id);
                }
            };
            let errorListener = (err: Error) => {
                clearTimeout(timer);
                this.socket.removeListener("connect", connectListener);
                reject(err);
            };

            if (this.path) {
                // connect IPC (Unix domain socket or Windows named pipe)
                this.socket = net.createConnection(this.path, connectListener);
            } else {
                // connect RPC
                this.socket = net.createConnection(
                    this.port,
                    this.host,
                    connectListener
                );
            }

            this.socket = this.bsp.wrap(this.socket);
            this.socket.once("error", errorListener);
        });
    }

    close(): Promise<this> {
        return new Promise(resolve => {
            clearInterval(this.pingTimer);
            clearTimeout(this.selfDestruction);
            this.state = "closed";
            this.reconnect.reset();
            this.pause();

            if (this.socket) {
                this.socket.unref();
                this.socket.end();
                resolve(this);
            } else {
                resolve(this);
            }
        });
    }

    register<T>(mod: ModuleProxy<T>) {
        if (!this.registry[mod.name]) {
            this.registry[mod.name] = mod;
            let singletons = (<ModuleProxyBase><any>mod)["remoteSingletons"];

            singletons[this.serverId] = createRemoteInstance(
                mod,
                (prop) => this.createFunction(<ModuleProxyBase><any>mod, prop)
            );
            singletons[this.serverId][readyState] = this.connected ? 2 : 0;
        }

        return this;
    }

    private setPingAndReconnectTimer(serverId: string) {
        this.pingTimer = setInterval(() => {
            // The strategy is, we only need to send a PING signal
            // to the server, and don't have to concern about
            // whether the server would or would not response a PONG
            // signal, we only need to detect if any data is
            // received from the server, and refresh the
            // lastActiveTime to prevent  sending too much
            // unnecessary PING/PONG frame.
            let duration = Date.now() - this.lastActiveTime;
            if (duration >= this.pingInterval) {
                this.selfDestruction = setTimeout(
                    this.socket.destroy.bind(this.socket),
                    this.timeout
                );

                this.send(RpcEvents.PING, this.id);
            }
        }, 5000);
        this.reconnect = exponential({
            maxDelay: 5000
        }).on("ready", async (num) => {
            // Retry connect in exponential timeout.
            try {
                await this.open();
            } catch (e) { }

            if (this.connected) {
                this.reconnect.reset();
                this.resume(); // resume service
            } else if (num === 365) {
                // If tried 365 times (about 30 minutes) and still
                // have no connection, then consider the server is
                // down permanently and close the client. 
                await this.close();
                console.error(
                    `Connection to ${serverId} lost permanently`
                );
            } else {
                this.reconnect.backoff();
            }
        });
    }

    private flushReadyState(state: number) {
        for (let name in this.registry) {
            let mod: ModuleProxyBase = <any>this.registry[name];
            let singletons = mod["remoteSingletons"];
            singletons[this.serverId][readyState] = state;
        }
    }

    /** Pauses the channel and redirect traffic to other channels. */
    pause(): void {
        this.flushReadyState(0);
    }

    /** Resumes the channel and continue handling traffic. */
    resume(): void {
        this.flushReadyState(2);
    }

    /** Subscribes a handle function to the corresponding topic. */
    subscribe(topic: string, handle: Subscriber) {
        let handlers = this.topics.get(topic);
        handlers || this.topics.set(topic, handlers = new Set());
        handlers.add(handle);
        return this;
    }

    /**
     * Unsubscribes the handle function or all handlers from the corresponding
     * topic.
     */
    unsubscribe(topic: string, handle?: Subscriber) {
        if (!handle) {
            return this.topics.delete(topic);
        } else {
            let handlers = this.topics.get(topic);

            if (handlers) {
                return handlers.delete(handle);
            } else {
                return false;
            }
        }
    }

    protected send(...data: Request) {
        if (this.socket && !this.socket.destroyed && this.socket.writable) {
            // If the last argument in the data is undefined, do not send it.
            if (last(data) === undefined) {
                data.pop();
            }

            this.socket.write(<any>data);
        }
    }

    protected createFunction(mod: ModuleProxyBase, method: string) {
        let self = this;
        return function (...args: any[]) {
            // If the RPC server and the RPC client runs in the same process,
            // then directly call the local instance to prevent unnecessary
            // network traffics.
            let root = (<ModuleProxyRoot>mod[proxyRoot]);
            if (root && root["server"] && root["server"].id === self.serverId) {
                let ins = mod.instance();

                if (isOwnKey(ins, readyState) && ins[readyState] !== 2 &&
                    !mod.fallbackToLocal()
                ) {
                    throwUnavailableError(mod.name);
                } else {
                    return new ThenableAsyncGenerator(ins[method](...args));
                }
            }

            // If the RPC channel is not available, call the local instance and
            // wrap it asynchronous.
            if (!self.connected) {
                if (mod.fallbackToLocal()) {
                    return new ThenableAsyncGenerator(
                        mod.instance()[method](...args)
                    );
                } else {
                    throwUnavailableError(mod.name);
                }
            }

            // Return a ThenableAsyncGenerator instance when the remote function
            // is called, so that it can be awaited or used as a generator.
            return new ThenableAsyncGenerator(new ThenableIteratorProxy(
                self,
                mod.name,
                method,
                ...args
            ));
        };
    }

    protected prepareChannel() {
        this.socket.on("error", err => {
            if (!isSocketResetError(err)) {
                if (this.errorHandler) {
                    this.errorHandler(err);
                } else {
                    console.error(err);
                }
            }
        }).on("close", () => {
            if (this.connecting) {
                this.rejectConnect && this.rejectConnect();
            } else if (!this.closed) {
                // If the socket is closed or reset. but the channel remains
                // open, pause the service immediately and try to reconnect.
                this.state = "connecting"; // MUST DO
                this.pause();
                this.reconnect && this.reconnect.backoff();
            }
        }).on("data", async (msg: Response) => {
            this.lastActiveTime = Date.now();

            if (this.selfDestruction) {
                clearTimeout(this.selfDestruction);
                this.selfDestruction = null;
            }

            if (this.codec === "BSON") {
                // BSON doesn't support top level array, they will be
                // transferred as an plain object with numeric keys, should
                // fix it before handling the response.
                msg = <any>Array.from(Object.assign(<any>msg, {
                    length: Object.keys(msg).length
                }));
            }

            let [event, taskId, data] = msg;
            let task: Task;

            switch (event) {
                case RpcEvents.CONNECT: {
                    if (data !== this.serverId) { // only for fresh connect
                        // Update remote singletons map.
                        for (let name in this.registry) {
                            let mod: ModuleProxyBase = <any>this.registry[name];
                            let singletons = mod["remoteSingletons"];

                            if (singletons[this.serverId]) {
                                singletons[data] = singletons[this.serverId];
                                delete singletons[this.serverId];
                            }
                        }
                    }

                    this.serverId = data;
                    this.finishConnect();
                    break;
                }

                case RpcEvents.BROADCAST: {
                    // If receives the broadcast event, call all the 
                    // handlers bound to the corresponding topic. 
                    let handlers = this.topics.get(<string>taskId);

                    if (handlers) {
                        handlers.forEach(async (handle) => {
                            try {
                                await handle(data);
                            } catch (err) {
                                this.errorHandler && this.errorHandler(err);
                            }
                        });
                    }
                    break;
                }

                // When receiving response from the server, resolve 
                // immediately.
                case RpcEvents.INVOKE:
                case RpcEvents.YIELD:
                case RpcEvents.RETURN: {
                    if (task = this.tasks.get(<number>taskId)) {
                        task.resolve(data);
                    }
                    break;
                }

                // If any error occurs on the server, it will be delivered
                // to the client.
                case RpcEvents.THROW: {
                    if (task = this.tasks.get(<number>taskId)) {
                        // Codec 'CLONE' uses `decompose` internally, but for
                        // other codecs, `decompose` must be explicit.
                        (this.codec !== "CLONE") && (data = decompose(data));
                        task.reject(data);
                    }
                    break;
                }
            }
        });

        return this;
    }
}

class ThenableIteratorProxy implements ThenableAsyncGeneratorLike {
    readonly taskId: number = this.client["taskId"].next().value;
    protected status: "initiating" | "pending" | "closed";
    protected result: any;
    protected args: any[];
    protected queue: Array<{
        event: RpcEvents,
        data?: any,
        resolve: Function,
        reject: Function;
    }> = [];

    constructor(
        protected client: RpcClient,
        protected modName: string,
        protected method: string,
        ...args: any[]
    ) {
        this.status = "initiating";
        // this.result = void 0;
        this.args = args;

        // Initiate the task immediately when the remote method is called, this
        // operation will create a individual task, it will either be awaited as
        // a promise or iterated as a iterator.
        this.result = this.invokeTask(RpcEvents.INVOKE, ...this.args);
    }

    next(value?: any) {
        return this.invokeTask(RpcEvents.YIELD, value);
    }

    return(value?: any) {
        return this.invokeTask(RpcEvents.RETURN, value);
    }

    throw(err?: Error) {
        return this.invokeTask(RpcEvents.THROW, err) as Promise<never>;
    }

    then(resolver: (data: any) => any, rejecter: (err: any) => any) {
        return Promise.resolve(this.result).then((res) => {
            // Mark the status to closed, so that any operations on the current
            // generator after will return the local result instead of
            // requesting the remote service again.
            this.status = "closed";
            this.result = res;

            // With INVOKE event, the task will finish immediately after
            // awaiting the response, once a task is finished, it should be 
            // removed from the queue right away.
            this.client["tasks"].delete(this.taskId);

            return res;
        }).then(resolver, rejecter);
    }

    protected close() {
        this.status = "closed";

        for (let task of this.queue) {
            switch (task.event) {
                case RpcEvents.INVOKE:
                    task.resolve(void 0);
                    break;

                case RpcEvents.YIELD:
                    task.resolve({ value: void 0, done: true });
                    break;

                case RpcEvents.RETURN:
                    task.resolve({ value: task.data, done: true });
                    break;

                case RpcEvents.THROW:
                    task.reject(task.data);
                    break;
            }
        }

        this.queue = [];
    }

    protected captureStackTrack() {
        let call = {};
        Error.captureStackTrace(call);
        return call as { readonly stack: string; };
    }

    protected resolveStackTrace(err: Error, call: { readonly stack: string; }) {
        let stacks = call.stack.split("\n");
        let offset = stacks.findIndex(
            line => line.startsWith("    at new ThenableIteratorProxy")
        );

        if (offset !== -1) {
            offset += 2;
            stacks = stacks.slice(offset);
            err.stack += "\n" + stacks.join("\n");
        }
    }

    protected creatTask(call: { readonly stack: string; }) {
        return {
            resolve: (data: any) => {
                if (this.status === "pending") {
                    if (this.queue.length > 0) {
                        this.queue.shift().resolve(data);
                    }
                }
            },
            reject: (err: any) => {
                if (this.status === "pending") {
                    if (this.queue.length > 0) {
                        this.resolveStackTrace(err, call);
                        this.queue.shift().reject(err);
                    }

                    this.close();
                }
            }
        };
    }

    protected createTimeout(call: { readonly stack: string; }) {
        return setTimeout(() => {
            if (this.queue.length > 0) {
                let task = this.queue.shift();
                let callee = `${this.modName}(<route>).${this.method}()`;
                let duration = humanizeDuration(this.client.timeout);
                let err = new Error(`${callee} timeout after ${duration}`);

                this.resolveStackTrace(err, call);
                task.reject(err);
            }

            this.close();
        }, this.client.timeout);
    }

    protected prepareTask(event: RpcEvents, data?: any): Promise<any> {
        let call = this.captureStackTrack();

        if (!this.client["tasks"].has(this.taskId)) {
            this.client["tasks"].set(this.taskId, this.creatTask(call));
        }

        // Pack every request as Promise, and assign the resolver and rejecter 
        // to the task, so that when the result or any error is received, 
        // they can be called properly.
        return new Promise((resolve, reject) => {
            let timer = this.createTimeout(call);

            this.queue.push({
                event,
                data,
                resolve: (data: any) => {
                    clearTimeout(timer);
                    resolve(data);
                },
                reject: (err: any) => {
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    protected async invokeTask(event: RpcEvents, ...args: any[]): Promise<any> {
        if (this.status === "closed") {
            switch (event) {
                case RpcEvents.INVOKE:
                    return Promise.resolve(this.result);

                case RpcEvents.YIELD:
                    return Promise.resolve({ value: undefined, done: true });

                case RpcEvents.RETURN:
                    return Promise.resolve({ value: args[0], done: true });

                case RpcEvents.THROW:
                    return Promise.reject(args[0]);
            }
        } else {
            if (this.status === "initiating" && event !== RpcEvents.INVOKE) {
                // If in a generator call and the generator hasn't been 
                // initiated, send the request with arguments for initiation on
                // the server.
                this.client["send"](
                    event,
                    this.taskId,
                    this.modName,
                    this.method,
                    [...this.args],
                    ...args
                );
            } else {
                this.client["send"](
                    event,
                    this.taskId,
                    this.modName,
                    this.method,
                    ...args
                );
            }

            this.status = "pending";

            try {
                let res = await this.prepareTask(event, args[0]);

                if (event !== RpcEvents.INVOKE) {
                    ("value" in res) || (res.value = void 0);

                    if (res.done) {
                        this.status = "closed";
                        this.result = res.value;
                        this.client["tasks"].delete(this.taskId);
                    }
                }

                return res;
            } catch (err) {
                this.status = "closed";
                this.client["tasks"].delete(this.taskId);

                throw err;
            }
        }
    }
}
