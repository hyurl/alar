import * as net from "net";
import sequid from "sequid";
import { obj2err, err2obj } from 'err2obj';
import { wrap } from 'bsp';
import { exponential } from "backoff";
import isSocketResetError = require('is-socket-reset-error');
import { ThenableAsyncGenerator, ThenableAsyncGeneratorLike } from 'thenable-generator';
import { RpcChannel, RpcEvents, RpcOptions, Response, Request } from "./channel";
import { remotized, createRemoteInstance } from "../util";

type Subscriber = (data: any) => void | Promise<void>;
type ChannelState = "initiated" | "connecting" | "connected" | "closed";
type Task = {
    resolve: (data: any) => void,
    reject: (err: Error) => void
};

export interface ClientOptions extends RpcOptions {
    timeout?: number;
    pingInterval?: number;
}

export class RpcClient extends RpcChannel implements ClientOptions {
    /** The unique ID of the client, used for the server publishing events. */
    readonly id: string;
    readonly timeout: number;
    readonly pingInterval: number;
    protected serverId: string;
    protected state: ChannelState = "initiated";
    protected socket: net.Socket = null;
    protected registry: { [name: string]: ModuleProxy<any> } = {};
    protected taskId = sequid(0, true);
    protected tasks: { [taskId: number]: Task; } = {};
    protected events: { [name: string]: Subscriber[] } = {};
    protected finishConnect: Function = null;
    private lastActiveTime: number = Date.now();
    protected selfDestruction: NodeJS.Timer = null;
    protected pingTimer = setInterval(() => {
        // The strategy is, we only need to send a PING signal to the server,
        // and don't have to concern about whether the server would or would not
        // response a PONG signal, we only need to detect if any data is 
        // received from the server, and refresh the lastActiveTime to prevent
        // sending too much unnecessary PING/PONG frame.
        if (Date.now() - this.lastActiveTime >= this.pingInterval) {
            this.selfDestruction = setTimeout(
                this.socket.destroy.bind(this.socket),
                this.timeout
            );

            this.send(RpcEvents.PING, this.id);
        }
    }, 5000);
    private reconConter = exponential({
        maxDelay: 9600
    }).on("ready", async (num) => {
        // Retry connect in exponential timeout.
        try {
            await this.open();
        } catch (e) { }

        if (this.connected) {
            this.reconConter.reset();
            this.resume(); // resume service
        } else if (num === 18) {
            // If tried 18 times (about 2 minutes) and still have no connection,
            // then consider the server is down permanently and close the client. 
            await this.close();
            console.error(`Connection to ${this.serverId} is lost permanently.`);
        } else {
            this.reconConter.backoff();
        }
    });

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: ClientOptions);
    constructor(options: string | number | ClientOptions, host?: string) {
        super(<any>options, host);
        this.id = this.id || Math.random().toString(16).slice(2);
        this.timeout = this.timeout || 5000;
        this.pingInterval = this.pingInterval || 5000;
        this.serverId = this.dsn;
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
            if (this.socket && this.socket.connecting) {
                throw new Error(`Channel to ${this.serverId} is already open`);
            } else if (this.closed) {
                throw new Error(
                    `Cannot reconnect to ${this.serverId} after closing the channel`
                );
            }

            this.state === "connecting";

            let connectListener = () => {
                this.socket.removeListener("error", errorListener);
                this.prepareChannel();
                this.finishConnect = () => {
                    this.state = "connected";
                    resolve(this);
                };

                // Sending the connection secret before hitting handshaking.
                if (this.secret) {
                    this.socket.write(this.secret, () => {
                        this.send(RpcEvents.HANDSHAKE, this.id);
                    });
                } else {
                    this.send(RpcEvents.HANDSHAKE, this.id);
                }
            };
            let errorListener = (err: Error) => {
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

            this.socket = wrap(this.socket);
            this.socket.once("error", errorListener);
        });
    }

    close(): Promise<this> {
        return new Promise(resolve => {
            clearInterval(this.pingTimer);
            clearTimeout(this.selfDestruction);
            this.state = "closed";
            this.reconConter.reset();
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

    register<T>(mod: ModuleProxy<T>): this {
        this.registry[mod.name] = mod;

        mod[remotized] = true;
        mod["remoteSingletons"][this.serverId] = createRemoteInstance(
            mod,
            (prop) => {
                return this.createFunction(mod.name, prop);
            }
        );

        return this;
    }

    /** Pauses the channel and redirect traffic to other channels. */
    pause(): boolean {
        let { serverId } = this;
        let success = false;

        for (let name in this.registry) {
            let instances = this.registry[name]["remoteSingletons"];

            // Remove the remote instance from the module proxy, for removed 
            // instance, the traffic will be redirected to other alive services,
            // if all the services are dead, RPC calling should just fail with 
            // errors.
            delete instances[serverId];
            success = true;
        }

        return success;
    }

    /** Resumes the channel and continue handling traffic. */
    resume(): boolean {
        let { serverId } = this;
        let success = false;

        for (let name in this.registry) {
            let instances = this.registry[name]["remoteSingletons"];

            if (!instances[serverId]) {
                this.register(this.registry[name]);
                success = true;
            }
        }

        return success;
    }

    /** Subscribes a listener function to the corresponding event. */
    subscribe(event: string, listener: Subscriber) {
        if (!this.events[event]) {
            this.events[event] = [];
        }

        this.events[event].push(listener);

        return this;
    }

    /**
     * Unsubscribes the `listener` or all listeners from the corresponding event.
     */
    unsubscribe(event: string, listener?: Subscriber) {
        if (!listener) {
            return this.events[event] ? (delete this.events[event]) : false;
        } else if (this.events[event]) {
            let i = this.events[event].indexOf(listener);
            return this.events[event].splice(i, 1).length > 0;
        } else {
            return false;
        }
    }

    send(...data: Request) {
        if (this.socket && !this.socket.destroyed && this.socket.writable) {
            // If the last argument in the data is undefined, do not send it.
            if (data[data.length - 1] === undefined) {
                data.pop();
            }

            this.socket.write(<any>data);
        }
    }

    protected createFunction(name: string, method: string) {
        let self = this;
        return function (...args: any[]) {
            // Return a ThenableAsyncGenerator instance when the remote function
            // is called, so that it can be awaited or used as a generator.
            return new ThenableAsyncGenerator(new ThenableIteratorProxy(
                self,
                name,
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
            if (!this.closed) {
                // If the socket is closed or reset. but the channel remains
                // open, pause the service immediately and try to reconnect.
                this.state = "connecting"; // MUST DO
                this.pause();
                this.reconConter.backoff();
            }
        }).on("data", async (msg: Response) => {
            this.lastActiveTime = Date.now();

            if (this.selfDestruction) {
                clearTimeout(this.selfDestruction);
                this.selfDestruction = null;
            }

            let [event, taskId, data] = msg;
            let task: Task;

            switch (event) {
                case RpcEvents.CONNECT:
                    this.serverId = data;
                    this.finishConnect();
                    break;

                case RpcEvents.BROADCAST:
                    // If receives the broadcast event, call all the 
                    // listeners bound to the corresponding event. 
                    let listeners = this.events[taskId] || [];

                    for (let handle of listeners) {
                        await handle(data);
                    }
                    break;

                // When receiving response from the server, resolve 
                // immediately.
                case RpcEvents.INVOKE:
                case RpcEvents.YIELD:
                case RpcEvents.RETURN:
                    if (task = this.tasks[taskId]) {
                        task.resolve(data);
                    }
                    break;

                // If any error occurs on the server, it will be delivered
                // to the client.
                case RpcEvents.THROW:
                    if (task = this.tasks[taskId]) {
                        task.reject(obj2err(data));
                    }
                    break;
            }
        });

        return this;
    }
}

class ThenableIteratorProxy implements ThenableAsyncGeneratorLike {
    readonly taskId: number = this.client["taskId"].next().value;
    protected status: "uninitiated" | "suspended" | "closed";
    protected result: any;
    protected args: any[];
    protected queue: Array<{
        event: RpcEvents,
        data?: any,
        resolve: Function,
        reject: Function
    }> = [];

    constructor(
        protected client: RpcClient,
        protected modname: string,
        protected method: string,
        ...args: any[]
    ) {
        this.status = "uninitiated";
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
        return this.invokeTask(RpcEvents.THROW, err2obj(err)) as Promise<never>;
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
            // removed from the list right away.
            delete this.client["tasks"][this.taskId];

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

    protected createTimeout() {
        return setTimeout(() => {
            let num = Math.round(this.client.timeout / 1000);
            let unit = num === 1 ? "second" : "seconds";

            if (this.queue.length > 0) {
                let task = this.queue.shift();
                let callee = `${this.modname}->${this.method}()`;

                task.reject(new Error(
                    `Request to ${callee} timeout after ${num} ${unit}`
                ));
            }

            this.close();
        }, this.client.timeout);
    }

    protected prepareTask(event: RpcEvents, data?: any): Promise<any> {
        let task: Task = this.client["tasks"][this.taskId];

        if (!task) {
            task = this.client["tasks"][this.taskId] = {
                resolve: (data: any) => {
                    if (this.status === "suspended") {
                        if (this.queue.length > 0) {
                            this.queue.shift().resolve(data);
                        }
                    }
                },
                reject: (err: any) => {
                    if (this.status === "suspended") {
                        if (this.queue.length > 0) {
                            this.queue.shift().reject(err);
                        }

                        this.close();
                    }
                }
            };
        }

        // Pack every request as Promise, and assign the resolver and rejecter 
        // to the task, so that when the result or any error is received, 
        // then can be called correctly.
        return new Promise((resolve, reject) => {
            let timer = this.createTimeout();

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

    protected invokeTask(event: RpcEvents, ...args: any[]): Promise<any> {
        if (this.status === "closed") {
            switch (event) {
                case RpcEvents.INVOKE:
                    return Promise.resolve(this.result);

                case RpcEvents.YIELD:
                    return Promise.resolve({ value: undefined, done: true });

                case RpcEvents.RETURN:
                    return Promise.resolve({ value: args[0], done: true });

                case RpcEvents.THROW:
                    return Promise.reject(obj2err(args[0]));
            }
        } else {
            if (this.status === "uninitiated" && event !== RpcEvents.INVOKE) {
                // If in a generator call and the generator hasn't been 
                // initiated, send the request with arguments for initiation on
                // the server.
                this.client.send(
                    event,
                    this.taskId,
                    this.modname,
                    this.method,
                    [...this.args],
                    ...args
                );
            } else {
                this.client.send(
                    event,
                    this.taskId,
                    this.modname,
                    this.method,
                    ...args
                );
            }

            this.status = "suspended";

            return this.prepareTask(event, args[0]).then(res => {
                if (event !== RpcEvents.INVOKE) {
                    ("value" in res) || (res.value = void 0);

                    if (res.done) {
                        this.status = "closed";
                        this.result = res.value;
                        delete this.client["tasks"][this.taskId];
                    }
                }

                return res;
            }).catch(err => {
                this.status = "closed";
                delete this.client["tasks"][this.taskId];

                throw err;
            });
        }
    }
}