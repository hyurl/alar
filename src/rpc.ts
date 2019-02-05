import * as net from "net";
import * as path from "path";
import * as fs from "fs-extra";
import { send, receive } from "bsp";
import isSocketResetError = require("is-socket-reset-error");
import { set, obj2err, err2obj, absPath } from './util';

export enum RpcEvents {
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
    host = "";
    port = 0;
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

            if (this.path) {
                await fs.ensureDir(path.dirname(this.path));

                if (await fs.pathExists(this.path)) {
                    await fs.unlink(this.path);
                }

                server.listen(absPath(this.path, true), listener);
            } else if (!this.host) {
                server.listen(this.port, listener);
            } else {
                server.listen(this.port, this.host, listener);
            }

            server.once("error", err => {
                !resolved && reject(err);
            }).on("error", err => {
                if (this.errorHandler && resolved) {
                    this.errorHandler.call(this, err);
                }
            }).on("connection", socket => {
                let remains: Buffer[] = [];

                socket.on("error", err => {
                    if (!isSocketResetError(err) && this.errorHandler) {
                        this.errorHandler.call(this, err);
                    }
                }).on("data", async (buf) => {
                    let msg = receive<[number, number, string, string, ...any[]]>(buf, remains);

                    for (let [event, taskId, name, method, ...args] of msg) {
                        if (event === RpcEvents.REQUEST) {
                            let event = RpcEvents.RESPONSE, data;

                            try {
                                let ins = this.registry[name].instance();
                                event = RpcEvents.RESPONSE;
                                data = await ins[method](...args);
                            } catch (err) {
                                event = RpcEvents.ERROR;
                                data = err2obj(err);
                            }

                            socket.write(send(event, taskId, data));
                        }
                    }
                });
            });
        });
    }

    close(): Promise<this> {
        return new Promise(resolve => {
            this.server ? this.server.close(() => {
                this.server.unref();
                resolve(this);
            }) : resolve(this);
        });
    }

    register<T>(mod: ModuleProxy<T>): this {
        this.registry[mod.name] = mod;
        return this;
    }
}

export class RpcClient extends RpcChannel {
    private socket: net.Socket;
    private queue: any[][] = [];
    private taskId: number = 0;
    private tasks: {
        [taskId: number]: {
            resolve: (res) => void,
            reject: (err) => void
        };
    } = {};

    open(): Promise<this> {
        return new Promise((resolve, reject) => {
            let resolved = false;
            let listener = () => {
                !resolved && resolve(this);

                while (this.queue.length) {
                    let data = this.queue.shift();
                    this.send(...data);
                }
            };
            let connect = () => {
                if (this.path) {
                    this.socket = net.createConnection(absPath(this.path, true), listener);
                } else {
                    this.socket = net.createConnection(this.port, this.host, listener);
                }
            };
            let remains: any[] = [];

            connect();

            this.socket.once("error", err => {
                !resolved && reject(err);
            }).on("error", err => {
                if (isSocketResetError(err)) {
                    this.socket.unref();

                    let times = 0;
                    let maxTimes = Math.round(this.timeout / 50);
                    let reconnect = () => {
                        let timer = setTimeout(() => {
                            connect();
                            times++;

                            if (!this.socket.destroyed
                                || this.socket.connecting) {
                                clearTimeout(timer);
                            } else if (times === maxTimes) {
                                clearTimeout(timer);
                                this.errorHandler.call(this, err);
                            } else {
                                reconnect();
                            }
                        }, 50);
                    };
                } else if (this.errorHandler && resolved) {
                    this.errorHandler.call(this, err);
                }
            }).on("data", buf => {
                let msg = receive<[number, number, any]>(buf, remains);

                for (let [event, taskId, data] of msg) {
                    if (this.tasks[taskId]) {
                        if (event === RpcEvents.RESPONSE) {
                            this.tasks[taskId].resolve(data);
                        } else if (event === RpcEvents.ERROR) {
                            this.tasks[taskId].reject(obj2err(data));
                        }
                    }
                }
            });
        });
    }

    close(): Promise<this> {
        return new Promise(resolve => {
            if (this.socket) {
                this.socket.destroy();
                this.socket.unref();
                resolve(this);
            } else {
                resolve(this);
            }
        });
    }

    register<T extends object>(mod: ModuleProxy<T>): this {
        let ins = new Proxy(mod.create(), {
            get: (ins, prop: string) => {
                if (typeof ins[prop] === "function" && !ins[prop].proxified) {
                    set(ins, prop, this.createFunction(ins, mod.name, prop));
                }

                return ins[prop];
            }
        });

        (<T[]>mod["remoteSingletons"]).push(ins);
        return this;
    }

    private send(...data: any[]) {
        if (this.socket && !this.socket.destroyed) {
            this.socket.write(send(...data));
        } else {
            this.queue.push(data);
        }
    }

    private getTaskId() {
        let taskId = this.taskId++;

        if (this.taskId === Number.MAX_SAFE_INTEGER)
            this.taskId = 0;

        return taskId;
    }

    private createFunction<T>(ins: T, name: string, method: string) {
        let $this = this;
        let originMethod = ins[method];
        let fn = function (...args: any[]): Promise<any> {
            return new Promise((resolve, reject) => {
                let taskId = $this.getTaskId();
                let { timeout } = $this;
                let timer = setTimeout(() => {
                    let num = Math.round(timeout / 1000),
                        unit = num === 1 ? "second" : "seconds";

                    delete $this.tasks[taskId];
                    reject(new Error(
                        `RPC request timeout after ${num} ${unit}`
                    ));
                }, timeout);


                $this.tasks[taskId] = {
                    resolve: (res) => {
                        resolve(res);
                        clearTimeout(timer);
                        delete $this.tasks[taskId];
                    },
                    reject: (err) => {
                        reject(err);
                        clearTimeout(timer);
                        delete $this.tasks[taskId];
                    }
                };

                $this.send(RpcEvents.REQUEST, taskId, name, method, ...args);
            });
        };

        set(fn, "proxified", true);
        set(fn, "name", method);
        set(fn, "length", originMethod.length);
        set(fn, "toString", function toString() {
            return Function.prototype.toString.call(originMethod);
        }, true);

        return fn;
    }
}