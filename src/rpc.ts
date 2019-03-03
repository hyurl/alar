import * as net from "net";
import * as path from "path";
import * as fs from "fs-extra";
import { send, receive } from "bsp";
import isSocketResetError = require("is-socket-reset-error");
import sleep = require("sleep-promise");
import {
    obj2err,
    err2obj,
    absPath,
    createRemoteInstance,
    mergeFnProperties,
    local,
    remotized
} from './util';

type Request = [number, number | string, string?, string?, ...any[]];
type Response = [number, number | string, any];
type Task = {
    resolve: (res: any) => void,
    reject: (err: Error) => void
};
type Subscriber = (data: any) => void | Promise<void>;
enum RpcEvents {
    HANDSHAKE,
    CONNECT,
    BROADCAST,
    REQUEST,
    RESPONSE,
    ERROR,
}

export interface RpcOptions {
    [x: string]: any;
    host?: string;
    port?: number;
    path?: string;
}

export interface ClientOptions extends RpcOptions {
    timeout?: number;
    id?: string;
}

/** An RPC channel that allows modules to communicate remotely. */
export abstract class RpcChannel implements RpcOptions {
    host = "0.0.0.0";
    port = 9000;
    path = "";
    protected errorHandler: (err: Error) => void;

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: RpcOptions);
    constructor(options: string | number | RpcOptions, host?: string) {
        if (typeof options === "object") {
            Object.assign(this, options);
        } else if (typeof options === "number") {
            Object.assign(this, { host, port: options });
        } else {
            this.path = absPath(options);
        }
    }

    /** Gets the data source name according to the configuration. */
    get dsn() {
        let dsn = this.path ? "ipc://" : "rpc://";

        if (this.path) {
            dsn += this.path;
        } else if (this.port) {
            if (this.host) {
                dsn += this.host + ":";
            }
            dsn += this.port;
        }

        return dsn;
    }

    /**
     * Binds an error handler invoked whenever an error occurred in asynchronous
     * operations which can't be caught during run-time.
     */
    onError(handler: (err: Error) => void) {
        this.errorHandler = handler;
    }

    /** Opens the channel. */
    abstract open(): Promise<this>;

    /** Closes the channel. */
    abstract close(): Promise<this>;

    /** Registers a module proxy to the channel. */
    abstract register<T extends object>(mod: ModuleProxy<T>): this;
}

export class RpcServer extends RpcChannel {
    private server: net.Server;
    private registry: { [name: string]: ModuleProxy<any> } = {};
    private clients = new Map<string, net.Socket>();

    open(): Promise<this> {
        return new Promise(async (resolve, reject) => {
            let server: net.Server = this.server = net.createServer(),
                resolved = false,
                listener = () => {
                    (resolved = true) && resolve(this);
                };

            if (this.path) { // server IPC (Unix domain socket or Windows named pipe)
                await fs.ensureDir(path.dirname(this.path));

                // If the path exists, it's more likely caused by a previous 
                // server process closing unexpected, just remove it before ship
                // the new server.
                if (await fs.pathExists(this.path)) {
                    await fs.unlink(this.path);
                }

                server.listen(absPath(this.path, true), listener);
            } else if (this.host) { // serve RPC with host name or IP.
                server.listen(this.port, this.host, listener);
            } else { // server RPC without host name or IP.
                server.listen(this.port, listener);
            }

            server.once("error", err => {
                !resolved && (resolved = true) && reject(err);
            }).on("error", err => {
                if (this.errorHandler && resolved) {
                    this.errorHandler.call(this, err);
                }
            }).on("connection", socket => {
                let temp: Buffer[] = [];

                socket.on("error", err => {
                    // When any error occurs, if it's a socket reset error, e.g.
                    // client disconnected unexpected, the server could just 
                    // ignore the error. For other errors, the server should 
                    // handle them with a custom handler.
                    if (!isSocketResetError(err) && this.errorHandler) {
                        this.errorHandler(err);
                    }
                }).on("end", () => {
                    socket.emit("close", false);
                }).on("close", () => {
                    for (let [id, _socket] of this.clients) {
                        if (Object.is(_socket, socket)) {
                            this.clients.delete(id);
                            break;
                        }
                    }
                }).on("data", async (buf) => {
                    let msg = receive<Request>(buf, temp);

                    for (let [event, taskId, name, method, ...args] of msg) {
                        if (event === RpcEvents.HANDSHAKE) {
                            this.clients.set(<string>taskId, socket);
                            // Send CONNECT event to notify the client that the 
                            // connection is finished.
                            this.dispatch(socket, RpcEvents.CONNECT);
                        } else if (event === RpcEvents.REQUEST) {
                            let event: RpcEvents, data: any;

                            try {
                                // Connect to the singleton instance and invokes
                                // it's method to handle the request.
                                let ins = this.registry[name].instance(local);
                                data = await ins[method](...args);
                                event = RpcEvents.RESPONSE;
                            } catch (err) {
                                event = RpcEvents.ERROR;
                                data = err2obj(err);
                            }

                            // Send response or error to the client.
                            this.dispatch(socket, event, taskId, data);
                        }
                    }
                });
            });
        });
    }

    close(): Promise<this> {
        return new Promise(resolve => {
            if (this.server) {
                this.server.unref();
                this.server.close(() => resolve(this));
            } else {
                resolve(this);
            }
        });
    }

    register<T>(mod: ModuleProxy<T>): this {
        this.registry[mod.name] = mod;
        return this;
    }

    /**
     * Publishes data to the corresponding event, if `clients` are provided, the
     * event will only be emitted to them.
     * 
     */
    publish(event: string, data: any, clients?: string[]) {
        let sent = false;
        let socket: net.Socket;
        let targets = clients || this.clients.keys();

        for (let id of targets) {
            if (socket = this.clients.get(id)) {
                this.dispatch(socket, RpcEvents.BROADCAST, event, data);
                sent = true;
            }
        }

        return sent;
    }

    /** Returns all IDs of clients that connected to the server. */
    getClients(): string[] {
        let clients: string[];
        this.clients.forEach((_, id) => clients.push(id));
        return clients;
    }

    private dispatch(socket: net.Socket, ...data: any[]) {
        if (!socket.destroyed && socket.writable) {
            socket.write(send(...data));
        }
    }
}

export class RpcClient extends RpcChannel implements ClientOptions {
    id: string;
    timeout: number;
    /** Whether the channel is in connecting state. */
    connecting = false;
    /** Whether the channel is connected. */
    connected = false;
    /** Whether the channel is closed. */
    closed = false;
    private socket: net.Socket;
    private initiated = false;
    private registry: { [name: string]: ModuleProxy<any> } = {};
    private temp: any[] = [];
    private taskId: number = 0;
    private tasks: { [taskId: number]: Task; } = {};
    private events: { [name: string]: Subscriber[] } = {};
    private finishConnect: Function;

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: RpcOptions);
    constructor(options: string | number | RpcOptions, host?: string) {
        super(<any>options, host);
        this.id = this.id || Math.random().toString(16).slice(2);
        this.timeout = this.timeout || 5000;
        this.socket = new net.Socket();
        this.socket.on("error", err => {
            if (this.connected && !isSocketResetError(err) && this.errorHandler) {
                this.errorHandler(err);
            }
        }).on("end", () => {
            // Emit close event so that the client can try reconnect in the 
            // background.
            if (!this.connecting && this.socket.destroyed) {
                this.socket.emit("close", false);
            }
        }).on("close", hadError => {
            // If the socket is closed or reset, pause the service immediately 
            // and try to reconnect if the channel is not closed.
            this.connected = false;
            this.pause();

            if (!this.closed && !this.connecting && this.initiated) {
                this.reconnect(hadError ? this.timeout : 0);
            }
        }).on("data", async (buf) => {
            let msg = receive<Response>(buf, this.temp);

            for (let [event, taskId, data] of msg) {
                let task: Task;

                switch (event) {
                    case RpcEvents.CONNECT:
                        this.finishConnect();
                        break;

                    case RpcEvents.BROADCAST:
                        // If receives the broadcast event, call all the listeners
                        // bound to the corresponding event. 
                        let listeners = this.events[taskId] || [];

                        for (let handle of listeners) {
                            await handle(data);
                        }
                        break;

                    // When receiving response from the server, resolve 
                    // immediately.
                    case RpcEvents.RESPONSE:
                        if (task = this.tasks[taskId]) {
                            task.resolve(data);
                        }
                        break;

                    // If any error occurs on the server, it will be delivered
                    // to the client.
                    case RpcEvents.ERROR:
                        if (task = this.tasks[taskId]) {
                            task.reject(obj2err(data));
                        }
                        break;
                }
            }
        });
    }

    open(): Promise<this> {
        return new Promise((resolve, reject) => {
            if (this.socket.connecting || this.connected || this.closed) {
                return resolve(this);
            }

            this.connecting = true;

            let listener = () => {
                this.initiated = true;
                this.connecting = false;
                this.socket.removeListener("error", errorListener);
                this.finishConnect = () => {
                    this.connected = true;
                    resolve(this);
                };
                this.send(RpcEvents.HANDSHAKE, this.id);
            };
            let errorListener = (err: Error) => {
                this.connecting = false;
                this.socket.removeListener("connect", listener);

                // An EALREADY error may happen if background re-connections
                // got conflicted and one of the them finishes connect 
                // before others.
                if (this.initiated) {
                    resolve(this);
                } else {
                    reject(err);
                }
            };

            if (this.path) { // connect IPC (Unix domain socket or Windows named pipe)
                this.socket.connect(absPath(this.path, true));
            } else { // connect RPC
                this.socket.connect(this.port, this.host);
            }

            this.socket.once("connect", listener).once("error", errorListener);
        });
    }

    close(): Promise<this> {
        return new Promise(resolve => {
            this.closed = true;
            this.connected = false;
            this.connecting = false;
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
        mod["remoteSingletons"][this.dsn] = createRemoteInstance(
            mod,
            (ins, prop) => {
                return this.createFunction(ins, mod.name, prop);
            }
        );

        return this;
    }

    /** Pauses the channel and redirect traffic to other channels. */
    pause(): boolean {
        let { dsn } = this;
        let success = false;

        for (let name in this.registry) {
            let instances = this.registry[name]["remoteSingletons"];

            // Remove the remote instance from the module proxy, for removed 
            // instance, the traffic will be redirected to other alive services,
            // if all the services are dead, RPC calling should just fail with 
            // errors.
            delete instances[dsn];
            success = true;
        }

        return success;
    }

    /** Resumes the channel and continue handling traffic. */
    resume(): boolean {
        let { dsn } = this;
        let success = false;

        for (let name in this.registry) {
            let instances = this.registry[name]["remoteSingletons"];

            if (!instances[dsn]) {
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

    private async reconnect(timeout = 0) {
        if (this.connected || this.connecting) return;

        try {
            this.connecting = true;
            timeout && (await sleep(timeout));
            await this.open();
        } catch (e) { }

        if (this.connected) {
            this.resume(); // resume service
        }
    }

    private send(...data: Request) {
        if (this.socket && !this.socket.destroyed && this.socket.writable) {
            this.socket.write(send(...data));
        }
    }

    private getTaskId() {
        let taskId = this.taskId++;

        if (this.taskId === Number.MAX_SAFE_INTEGER)
            this.taskId = 0;

        return taskId;
    }

    private createTask(resolve: Function, reject: Function): number {
        let taskId = this.getTaskId();
        let timer = setTimeout(() => { // Set a timer to reject when timeout.
            let task = this.tasks[taskId];
            let num = Math.round(this.timeout / 1000);
            let unit = num === 1 ? "second" : "seconds";

            task.reject(new Error(
                `RPC request timeout after ${num} ${unit}`
            ));
        }, this.timeout);
        let clean = () => {
            clearTimeout(timer);
            delete this.tasks[taskId];
            return true;
        };

        this.tasks[taskId] = {
            resolve: (res: any) => clean() && resolve(res),
            reject: (err: Error) => clean() && reject(err)
        };

        return taskId;
    }

    private createFunction<T>(ins: T, name: string, method: string) {
        let self = this;
        let originMethod = ins[method];
        let fn = function (...args: any[]): Promise<any> {
            return new Promise(async (resolve, reject) => {
                let taskId = self.createTask(resolve, reject);

                self.send(RpcEvents.REQUEST, taskId, name, method, ...args);
            });
        };

        return mergeFnProperties(fn, originMethod);
    }
}