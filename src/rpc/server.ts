import * as net from "net";
import * as path from "path";
import * as fs from "fs-extra";
import { err2obj } from "err2obj";
import { send, receive } from "bsp";
import { BiMap } from "advanced-collections";
import { isIteratorLike } from "check-iterable";
import { source, ThenableAsyncGenerator } from "thenable-generator";
import isSocketResetError = require("is-socket-reset-error");
import { RpcChannel, RpcEvents, Request } from "./channel";
import { absPath, local } from "../util";

const authorized = Symbol("authorized");

export class RpcServer extends RpcChannel {
    protected server: net.Server;
    protected registry: { [name: string]: ModuleProxy<any> } = {};
    protected clients = new BiMap<string, net.Socket>();
    protected suspendedTasks = new Map<net.Socket, {
        [taskId: number]: ThenableAsyncGenerator;
    }>();

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
        let clients: string[] = [];

        for (let [id] of this.clients) {
            clients.push(id);
        }

        return clients;
    }

    protected dispatch(socket: net.Socket, ...data: any[]) {
        if (!socket.destroyed && socket.writable) {
            socket.write(send(...data));
        }
    }

    protected handleConnection(socket: net.Socket) {
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
            this.clients.deleteValue(socket);

            let tasks = this.suspendedTasks.get(socket);
            this.suspendedTasks.delete(socket);

            // close all suspended tasks of the socket.
            for (let id in tasks) {
                tasks[id].return();
            }
        }).on("data", async (buf) => {
            if (!socket[authorized]) {
                if (this.secret) {
                    let index = buf.indexOf("\r\n");
                    let secret = buf.slice(0, index).toString();

                    if (secret !== this.secret) {
                        return socket.destroy();
                    } else {
                        buf = buf.slice(index + 2);
                    }
                }

                socket[authorized] = true;
            }

            let msg = receive<Request>(buf, temp);

            for (let [event, taskId, modname, method, ...args] of msg) {
                switch (event) {
                    case RpcEvents.HANDSHAKE:
                        this.clients.set(<string>taskId, socket);
                        this.suspendedTasks.set(socket, {});
                        // Send CONNECT event to notify the client that the 
                        // connection is finished.
                        this.dispatch(socket, RpcEvents.CONNECT);
                        break;

                    case RpcEvents.PING:
                        this.dispatch(socket, RpcEvents.PONG);
                        break;

                    case RpcEvents.INVOKE:
                        {
                            let data: any;
                            let tasks = this.suspendedTasks.get(socket) || {};

                            try {
                                // Connect to the singleton instance and 
                                // invokes it's method to handle the request.
                                let ins = this.registry[modname].instance(local);
                                let task = ins[method].apply(ins, args);

                                if (task && isIteratorLike(task[source])) {
                                    tasks[taskId] = task;
                                    event = RpcEvents.INVOKE;
                                } else {
                                    data = await task;
                                    event = RpcEvents.RETURN;
                                }
                            } catch (err) {
                                event = RpcEvents.THROW;
                                data = err2obj(err);
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
                            let tasks = this.suspendedTasks.get(socket) || {};
                            let task: ThenableAsyncGenerator = tasks[taskId];

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

                                data.done && (delete tasks[taskId]);
                            } catch (err) {
                                event = RpcEvents.THROW;
                                data = err2obj(err);
                                task && (delete tasks[taskId]);
                            }

                            this.dispatch(socket, event, taskId, data);
                        }
                        break;

                }
            }
        });
    }
}