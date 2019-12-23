import * as net from "net";
import * as path from "path";
import * as fs from "fs-extra";
import { clone } from '@hyurl/structured-clone';
import { BiMap } from "advanced-collections";
import { isIteratorLike } from "check-iterable";
import { source, ThenableAsyncGenerator } from "thenable-generator";
import isSocketResetError = require("is-socket-reset-error");
import { RpcChannel, RpcEvents, Request, RpcOptions } from "./channel";
import { absPath, local, RpcState, tryLifeCycleFunction } from "../util";
import { ModuleProxyBase } from '..';

const authorized = Symbol("authorized");

export class RpcServer extends RpcChannel {
    /** The unique ID of the server, used for the client routing requests. */
    readonly id: string;
    protected server: net.Server;
    protected registry: { [name: string]: ModuleProxy<any> } = {};
    protected clients = new BiMap<string, net.Socket>();
    protected suspendedTasks = new Map<net.Socket, Map<number, ThenableAsyncGenerator>>();

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: RpcOptions);
    constructor(options: string | number | RpcOptions, host?: string) {
        super(<any>options, host);
        this.id = this.id || this.dsn;
    }

    open(): Promise<this> {
        return new Promise(async (resolve, reject) => {
            let server: net.Server = this.server = net.createServer();
            let listener = () => {
                resolve(this);
                server.on("error", err => {
                    this.errorHandler && this.errorHandler.call(this, err);
                });
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

            server.once("error", reject)
                .on("connection", this.handleConnection.bind(this));
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

        for (let name in this.registry) {
            let mod = <ModuleProxy<any> & ModuleProxyBase>this.registry[name];

            if (mod[RpcState] && mod["singletons"][mod.name]) {
                mod[RpcState] = 2;
                await tryLifeCycleFunction(mod, "destroy");
                mod[RpcState] = 0;
            }
        }

        return this;
    }

    register<T>(mod: ModuleProxy<T>) {
        this.registry[mod.name] = mod;
        return this;
    }

    /** Performs initiation processes for registered modules. */
    async init() {
        for (let name in this.registry) {
            let mod = <ModuleProxy<any> & ModuleProxyBase>this.registry[name];

            mod[RpcState] = 0;
            await tryLifeCycleFunction(mod, "init");
            mod[RpcState] = 1;
        }
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
                data = clone(data);
            }

            socket.write(<any>[event, ...data]);
        }
    }

    protected handleConnection(socket: net.Socket) {
        let autoDestroy = setTimeout(() => {
            socket.destroy(new Error("Handshake required"));
        }, 1000);

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
                    return socket.destroy(new Error("Connection unauthorized"));
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

            if (Array.isArray(msg)) {
                let [event, taskId, modname, method, ...args] = msg;

                switch (event) {
                    case RpcEvents.HANDSHAKE:
                        clearTimeout(autoDestroy);
                        this.clients.set(<string>taskId, socket);
                        this.suspendedTasks.set(socket, new Map());
                        // Send CONNECT event to notify the client that the 
                        // connection is finished.
                        this.dispatch(socket, RpcEvents.CONNECT, taskId, this.id);
                        break;

                    case RpcEvents.PING:
                        this.dispatch(socket, RpcEvents.PONG);
                        break;

                    case RpcEvents.INVOKE:
                        {
                            let data: any;
                            let tasks = this.suspendedTasks.get(socket);

                            try {
                                // Connect to the singleton instance and 
                                // invokes it's method to handle the request.
                                let ins = this.registry[modname].instance(local);
                                let task = ins[method].apply(ins, args);

                                if (task && isIteratorLike(task[source])) {
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
                        }
                        break;

                    case RpcEvents.YIELD:
                    case RpcEvents.RETURN:
                    case RpcEvents.THROW:
                        {
                            let data: any, input: any;
                            let tasks = this.suspendedTasks.get(socket);
                            let task = tasks.get(<number>taskId);

                            try {
                                if (!task) {
                                    let callee = `${modname}->${method}()`;

                                    throw new ReferenceError(
                                        `Task (${taskId}) of ${callee} doesn't exist`
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
                                    // Calling the throw method will cause an
                                    // error being thrown and go to the catch
                                    // block.
                                    await task.throw(input);
                                }

                                data.done && tasks.delete(<number>taskId);
                            } catch (err) {
                                event = RpcEvents.THROW;
                                data = err;
                                task && tasks.delete(<number>taskId);
                            }

                            this.dispatch(socket, event, taskId, data);
                        }
                        break;

                }
            }
        });
    }
}