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
    mergeFnProperties
} from './util';

type Request = [number, number, string, string, ...any[]];
type Response = [number, number, any];
type Task = {
    resolve: (res: any) => void,
    reject: (err: Error) => void
};
enum RpcEvents {
    REQUEST,
    RESPONSE,
    ERROR,
}

export interface RpcOptions {
    host?: string;
    port?: number;
    path?: string;
    timeout?: number;
}

/** An RPC channel that allows modules to communicate remotely. */
export abstract class RpcChannel implements RpcOptions {
    host = "0.0.0.0";
    port = 9000;
    path = "";
    timeout = 5000;
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
                }).on("data", async (buf) => {
                    let msg = receive<Request>(buf, temp);

                    for (let [event, taskId, name, method, ...args] of msg) {
                        if (event === RpcEvents.REQUEST) {
                            let event: RpcEvents, data: any;

                            try {
                                // Connect to the singleton instance and invokes
                                // it's method to handle the request.
                                let ins = this.registry[name].instance();
                                data = await ins[method](...args);
                                event = RpcEvents.RESPONSE;
                            } catch (err) {
                                event = RpcEvents.ERROR;
                                data = err2obj(err);
                            }

                            // Send response or error to the client,
                            socket.write(send(event, taskId, data));
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
}

export class RpcClient extends RpcChannel {
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

    private init() {
        this.socket = new net.Socket();
        this.socket.on("error", err => {
            if (this.connected && isSocketResetError(err)) {
                // If the socket is reset, emit close event so that the 
                // channel could try to reconnect it automatically.
                this.socket.emit("close", !!err);
            } else if (this.connected && this.errorHandler) {
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

            if (!this.closed && !this.connecting) {
                this.reconnect(hadError ? this.timeout : 0);
            }
        }).on("data", buf => {
            let msg = receive<Response>(buf, this.temp);

            for (let [event, taskId, data] of msg) {
                let task = this.tasks[taskId];

                // If the task exists, when receiving response or error from
                // the server, resolve or reject them, and remove the task 
                // immediately.
                if (task) {
                    if (event === RpcEvents.RESPONSE) {
                        task.resolve(data);
                    } else if (event === RpcEvents.ERROR) {
                        task.reject(obj2err(data));
                    }
                }
            }
        });
    }

    open(): Promise<this> {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                this.init();
            } else if (this.socket.connecting || this.connected || this.closed) {
                return resolve(this);
            }

            this.connecting = true;

            let listener = () => {
                this.initiated = true;
                this.connected = !this.socket.destroyed;
                this.connecting = false;
                this.socket.removeListener("error", errorListener);
                resolve(this);
            };
            let errorListener = (err: Error) => {
                this.connecting = false;
                this.socket.removeListener("connect", listener);

                // An EALREADY error may happen if background re-connections
                // got conflicted and one of the them finishes connect 
                // before others.
                if (this.initiated) {
                    // If `defer` is enabled, when connection failed, 
                    // the channel will resolve immediately without error,
                    // and emit close event so that the channel could try to 
                    // reconnect it automatically.
                    this.socket.emit("close", !!err);
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

    register<T extends object>(mod: ModuleProxy<T>): this {
        this.registry[mod.name] = mod;

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

            // Remove the remote instance from the module proxy, but keep at 
            // least one instance alive if the channel is not closed. For 
            // removed instance, the traffic will be redirected to other alive 
            // services, if the final service is also dead, RPC calling should 
            // just throw timeout errors.
            if (this.closed || Object.keys(instances).length > 1) {
                delete instances[dsn];
                success = true;
            }
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
        if (this.socket && !this.socket.destroyed) {
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