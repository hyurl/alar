import * as net from "net";
import * as path from "path";
import * as fs from "fs-extra";
import { compose } from '@hyurl/structured-clone';
import { BiMap } from "advanced-collections";
import { isIteratorLike } from "check-iterable";
import { ThenableAsyncGenerator } from "thenable-generator";
import isSocketResetError = require("is-socket-reset-error");
import { RpcChannel, RpcEvents, Request, RpcOptions } from "./channel";
import { ModuleProxy as ModuleProxyRoot } from "..";
import {
    dict,
    absPath,
    readyState,
    tryLifeCycleFunction,
    throwUnavailableError,
} from "../util";
import values = require('lodash/values');
import isOwnKey from "@hyurl/utils/isOwnKey";

const authorized = Symbol("authorized");

export class RpcServer extends RpcChannel {
    /** The unique ID of the server, used for the client routing requests. */
    readonly id: string;
    protected server: net.Server = null;
    protected registry: { [name: string]: ModuleProxy<any> } = dict();
    protected clients = new BiMap<string, net.Socket>();
    protected suspendedTasks = new Map<net.Socket, Map<number, ThenableAsyncGenerator>>();
    protected proxyRoot: ModuleProxyRoot = null;
    protected enableLifeCycle = false;

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: RpcOptions);
    constructor(options: string | number | RpcOptions, host?: string) {
        super(<any>options, host);
        this.id = this.id || this.dsn;
    }

    /**
     * @param enableLifeCycle default value: `true`
     */
    async open(enableLifeCycle = true): Promise<this> {
        if (enableLifeCycle) {
            this.enableLifeCycle = true;

            // Perform initiation for every module in sequence.
            for (let mod of values(this.registry)) {
                await tryLifeCycleFunction(mod, "init", this.errorHandler);
            }
        }

        if (this.path) {
            await fs.ensureDir(path.dirname(this.path));

            // If the path exists, it's more likely caused by a previous 
            // server process closing unexpected, just remove it before ship
            // the new server.
            if (await fs.pathExists(this.path)) {
                await fs.unlink(this.path);
            }
        }

        return new Promise((resolve, reject) => {
            let server = this.server = net.createServer();
            let listener = () => {
                server.on("error", (err: Error) => {
                    if (this.errorHandler) {
                        this.errorHandler.call(this, err);
                    } else {
                        // If no error handler is provided, when any error
                        // occurred, terminate the program.
                        console.error(err);
                        process.exit(1);
                    }
                });

                resolve(this);
            };

            server.once("error", reject)
                .on("connection", this.handleConnection.bind(this));

            if (this.path) {// server IPC (Unix domain socket/Windows named pipe)
                server.listen(absPath(this.path, true), listener);
            } else if (this.host) { // serve RPC with host name or IP.
                server.listen(this.port, this.host, listener);
            } else { // server RPC without host name or IP.
                server.listen(this.port, listener);
            }
        });
    }

    async close(): Promise<this> {
        await new Promise<void>(resolve => {
            if (this.server) {
                let timer = setTimeout(() => {
                    for (let [, socket] of this.clients) {
                        socket.destroy();
                    }
                }, 1000);

                this.server.unref();
                this.server.close(() => {
                    clearTimeout(timer);
                    resolve();
                });
            } else {
                resolve();
            }
        });

        if (this.enableLifeCycle) {
            // Perform destructions for every module all at once.
            await Promise.all(values(this.registry).map(mod => {
                return tryLifeCycleFunction(mod, "destroy").catch(err => {
                    this.errorHandler && this.errorHandler(err);
                });
            }));
        }

        if (this.proxyRoot) {
            this.proxyRoot["server"] = null;
            this.proxyRoot = null;
        }

        return this;
    }

    register<T>(mod: ModuleProxy<T>) {
        this.registry[mod.name] = mod;
        return this;
    }

    /**
     * Publishes data to the corresponding topic, if `clients` are provided, the
     * topic will only be published to them.
     */
    publish(topic: string, data: any, clients?: string[]) {
        let sent = false;
        let socket: net.Socket;
        let targets = clients || this.clients.keys();

        for (let id of targets) {
            if (socket = this.clients.get(id)) {
                this.dispatch(socket, RpcEvents.BROADCAST, topic, data);
                sent = true;
            }
        }

        return sent;
    }

    /** Returns all IDs of clients that connected to the server. */
    getClients(): string[] {
        let clients: string[] = [];

        for (let [id] of this.clients) {
            clients.push(id);
        }

        return clients;
    }

    protected dispatch(socket: net.Socket, event: RpcEvents, ...data: any[]) {
        if (!socket.destroyed && socket.writable) {
            if (event === RpcEvents.THROW) {
                // Use structured clone algorithm to process error.
                data = compose(data);
            }

            socket.write(<any>[event, ...data]);
        }
    }

    protected handleConnection(socket: net.Socket) {
        let addr = `${socket.remoteAddress || ""}:${socket.remotePort || ""}`;
        let destroyWithHandshakeError = () => {
            socket.destroy(new Error(`Handshake required (client: ${addr})`));
        };
        let autoDestroy = setTimeout(destroyWithHandshakeError, 1000);

        this.bsp.wrap(socket).on("error", err => {
            // When any error occurs, if it's a socket reset error, e.g.
            // client disconnected unexpected, the server could just 
            // ignore the error. For other errors, the server should 
            // handle them with a custom handler.
            if (!isSocketResetError(err) && this.errorHandler) {
                this.errorHandler(err);
            }
        }).on("close", () => {
            let tasks = this.suspendedTasks.get(socket);

            if (tasks) {
                this.suspendedTasks.delete(socket);
                this.clients.deleteValue(socket);

                // close all suspended tasks of the socket.
                for (let task of tasks.values()) {
                    task.return();
                }
            }
        }).on("data", async (msg: string | Request) => {
            if (this.secret && !socket[authorized]) {
                if (this.secret === msg) {
                    socket[authorized] = true;
                    return;
                } else {
                    return socket.destroy(
                        new Error(`Connection unauthorized (client: ${addr})`)
                    );
                }
            }

            if (this.codec === "BSON" && typeof msg === "object") {
                // BSON doesn't support top level array, they will be
                // transferred as an plain object with numeric keys, should
                // fix it before handling the request.
                msg = <any>Array.from(Object.assign(<any>msg, {
                    length: Object.keys(msg).length
                }));
            }

            if (!Array.isArray(msg))
                return;

            let [event, taskId, modName, method, ...args] = msg;

            // If trying to invoke RPC functions before handshake,
            // report error and destroy the socket.
            if (!this.suspendedTasks.has(socket) &&
                event !== RpcEvents.HANDSHAKE) {
                return destroyWithHandshakeError();
            }

            switch (event) {
                case RpcEvents.HANDSHAKE: {
                    let clientId = String(taskId);
                    clearTimeout(autoDestroy);
                    this.clients.set(clientId, socket);
                    this.suspendedTasks.set(socket, new Map());
                    // Send CONNECT event to notify the client that the 
                    // connection is complete.
                    this.dispatch(socket, RpcEvents.CONNECT, clientId, this.id);
                    break;
                }

                case RpcEvents.PING: {
                    this.dispatch(socket, RpcEvents.PONG);
                    break;
                }

                case RpcEvents.INVOKE: {
                    let data: any;
                    let tasks = this.suspendedTasks.get(socket);

                    try {
                        // Connect to the singleton instance and invokes it's
                        // method to handle the request.
                        let ins = this.registry[modName]();

                        if (isOwnKey(ins, readyState) && ins[readyState] !== 2) {
                            throwUnavailableError(modName);
                        }

                        let task = ins[method].apply(ins, args);

                        if (task && isIteratorLike(task)) {
                            tasks.set(<number>taskId, task);
                            event = RpcEvents.INVOKE;
                        } else {
                            data = await task;
                            event = RpcEvents.RETURN;
                        }
                    } catch (err) {
                        event = RpcEvents.THROW;
                        data = err;
                    }

                    // Send response or error to the client.
                    this.dispatch(socket, event, taskId, data);
                    break;
                }

                case RpcEvents.YIELD:
                case RpcEvents.RETURN:
                case RpcEvents.THROW: {
                    let data: any, input: any;
                    let tasks = this.suspendedTasks.get(socket);
                    let task = tasks.get(<number>taskId);

                    try {
                        if (!task) {
                            let callee = `${modName}(<route>).${method}()`;
                            throw new ReferenceError(
                                `${callee} failed (${taskId})`
                            );
                        } else {
                            input = args[0];
                        }

                        // Invokes the generator's method according to
                        // the event.
                        if (event === RpcEvents.YIELD) {
                            data = await task.next(input);
                        } else if (event === RpcEvents.RETURN) {
                            data = await task.return(input);
                        } else {
                            // Calling the throw method will cause an error
                            // being thrown and go to the catch block.
                            await task.throw(input);
                        }

                        data.done && tasks.delete(<number>taskId);
                    } catch (err) {
                        event = RpcEvents.THROW;
                        data = err;
                        task && tasks.delete(<number>taskId);
                    }

                    this.dispatch(socket, event, taskId, data);
                    break;
                }
            }
        });
    }
}