import * as os from "os";
import * as net from "net";
import * as path from "path";
import * as fs from "fs-extra";
import { send, receive } from "bsp";
import { AssertionError } from 'assert';
import pick = require("lodash/pick");
import omit = require("lodash/omit");
import isSocketResetError = require("is-socket-reset-error");
import { ModuleProxy as Module } from '.';

const proxified = Symbol("proxified");
var taskId = 0;

export const Tasks: {
    [taskId: number]: {
        resolve: (res) => void,
        reject: (err) => void
    };
} = {};

export enum RPCEvents {
    REQUEST,
    RESPONSE,
    ERROR,
}

export interface RemoteOptions {
    host?: string;
    port?: number;
    path?: string;
    timeout?: number;
}

export class RemoteService implements RemoteOptions {
    host = "";
    port = 0;
    path = "";
    timeout = 5000;
    private server: net.Server;
    private socket: net.Socket;
    private errorHandler: (err: Error) => void;
    private queue: any[][] = [];

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: RemoteOptions);
    constructor(options: string | number | RemoteOptions, host?: string) {
        if (typeof options === "object") {
            Object.assign(this, options);
        } else if (typeof options === "number") {
            Object.assign(this, { host, port: options });
        } else {
            this.path = options;
        }
    }

    /** 
     * Starts the service server, listening for connections and requests from a 
     * socket.
     */
    serve(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            let server: net.Server = this.server = net.createServer(),
                resolved = false,
                listener = () => {
                    (resolved = true) && resolve();
                };

            if (this.path) {
                await fs.ensureDir(path.dirname(this.path));

                if (await fs.pathExists(this.path)) {
                    await fs.unlink(this.path);
                }

                server.listen(this.path, listener);
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
                        if (event === RPCEvents.REQUEST) {
                            let event = RPCEvents.RESPONSE, data;

                            try {
                                let ins = Module.registry[name].instance();
                                event = RPCEvents.RESPONSE;
                                data = await ins[method](...args);
                            } catch (err) {
                                event = RPCEvents.ERROR;
                                data = err2obj(err);
                            }

                            socket.write(send(event, taskId, data));
                        }
                    }
                });
            });
        });
    }

    /**
     * Connects to the service server and returns a new instance of `target`. 
     * @param args If provided, is any number of arguments passed to the class 
     * constructor. When the service is connected, they will be assigned to the 
     * instance on the server as well.
     */
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            let resolved = false;
            let listener = () => {
                !resolved && resolve();

                while (this.queue.length) {
                    let data = this.queue.shift();
                    this.send(...data);
                }
            };
            let connect = () => {
                if (this.path) {
                    this.socket = net.createConnection(this.path, listener);
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
                    if (event === RPCEvents.RESPONSE) {
                        Tasks[taskId].resolve(data);
                    } else if (event === RPCEvents.ERROR) {
                        Tasks[taskId].reject(obj2err(data));
                    }
                }
            });
        });
    }

    close(): Promise<void> {
        return new Promise(resolve => {
            if (this.socket) {
                this.socket.destroy();
                this.socket.unref();
            }

            if (this.server) {
                this.server.close(() => {
                    this.server.unref();
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Binds an error handler to be invoked whenever an error occurred in 
     * asynchronous operations which can't be caught during run-time.
     */
    onError(handler: (err: Error) => void) {
        this.errorHandler = handler;
    }

    send(...data: any[]) {
        if (this.socket && !this.socket.destroyed) {
            this.socket.write(send(...data));
        } else {
            this.queue.push(data);
        }
    }
}

export function createRemoteInstance<T extends object>(
    mod: ModuleProxy<T>,
    remoteService: RemoteService
): T {
    return new Proxy(mod.create(), {
        get: (ins, prop: string) => {
            if (!(prop in ins) || typeof ins[prop] != "function") {
                return ins[prop];
            } else if (!ins[prop][proxified]) {
                let fn = function (...args: any[]) {
                    return new Promise((resolve, reject) => {
                        let { timeout } = remoteService;

                        let timer = setTimeout(() => {
                            let num = Math.round(timeout / 1000),
                                unit = num === 1 ? "second" : "seconds";

                            reject(new Error(
                                `RPC request timeout after ${num} ${unit}`
                            ));
                        }, timeout);

                        remoteService.send(
                            RPCEvents.REQUEST,
                            taskId,
                            mod.name,
                            prop,
                            ...args
                        );

                        Tasks[taskId] = {
                            resolve: (res) => {
                                resolve(res);
                                clearTimeout(timer);
                                delete Tasks[taskId];
                            },
                            reject: (err) => {
                                reject(err);
                                clearTimeout(timer);
                                delete Tasks[taskId];
                            }
                        };

                        taskId++;
                        if (taskId === Number.MAX_SAFE_INTEGER)
                            taskId = 0;
                    });
                };

                set(fn, prop, fn);
                set(fn, "name", ins[prop].name);
                set(fn, "length", ins[prop].length);
                set(fn, proxified, true);
                set(fn, "toString", function toString() {
                    return Function.prototype.toString.call(ins[prop]);
                }, true);

                return fn;
            } else {
                return ins[prop];
            }
        }
    });
}

export function absPath(filename: string): string {
    // resolve path to be absolute
    if (!path.isAbsolute(filename)) {
        filename = path.resolve(os.tmpdir(), ".separ", filename);
    }

    if (os.platform() == "win32" && !(/\\\\[\?\.]\\pipe\\/.test(filename))) {
        filename = "\\\\?\\pipe\\" + filename;
    }

    return filename;
}

function set(target, prop, value, writable = false) {
    Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        writable,
        value
    });
}

type ErrorObject = Error & { [x: string]: any };

export function err2obj(err: ErrorObject): ErrorObject {
    let props = ["name", "message", "stack"];
    return Object.assign({}, pick(err, props), omit(props)) as any;
}

export function obj2err(obj: ErrorObject): ErrorObject {
    let Errors = {
        AssertionError,
        Error,
        EvalError,
        RangeError,
        ReferenceError,
        SyntaxError,
        TypeError,
    };
    let err = Object.create((Errors[obj.name] || Error).prototype);
    let props = ["name", "message", "stack"];

    for (let prop in obj) {
        if (props.indexOf(prop) >= 0) {
            set(err, prop, obj[prop], true);
        } else {
            err[prop] = obj[prop];
        }
    }

    return err;
}