"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const net = require("net");
const path = require("path");
const fs = require("fs-extra");
const bsp_1 = require("bsp");
const isSocketResetError = require("is-socket-reset-error");
const sleep = require("sleep-promise");
const util_1 = require("./util");
var RpcEvents;
(function (RpcEvents) {
    RpcEvents[RpcEvents["HANDSHAKE"] = 0] = "HANDSHAKE";
    RpcEvents[RpcEvents["CONNECT"] = 1] = "CONNECT";
    RpcEvents[RpcEvents["BROADCAST"] = 2] = "BROADCAST";
    RpcEvents[RpcEvents["REQUEST"] = 3] = "REQUEST";
    RpcEvents[RpcEvents["RESPONSE"] = 4] = "RESPONSE";
    RpcEvents[RpcEvents["ERROR"] = 5] = "ERROR";
})(RpcEvents || (RpcEvents = {}));
class RpcChannel {
    constructor(options, host) {
        this.host = "0.0.0.0";
        this.port = 9000;
        this.path = "";
        if (typeof options === "object") {
            Object.assign(this, options);
        }
        else if (typeof options === "number") {
            Object.assign(this, { host, port: options });
        }
        else {
            this.path = util_1.absPath(options);
        }
    }
    get dsn() {
        let dsn = this.path ? "ipc://" : "rpc://";
        if (this.path) {
            dsn += this.path;
        }
        else if (this.port) {
            if (this.host) {
                dsn += this.host + ":";
            }
            dsn += this.port;
        }
        return dsn;
    }
    onError(handler) {
        this.errorHandler = handler;
    }
}
exports.RpcChannel = RpcChannel;
class RpcServer extends RpcChannel {
    constructor() {
        super(...arguments);
        this.registry = {};
        this.clients = new Map();
    }
    open() {
        return new Promise((resolve, reject) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            let server = this.server = net.createServer(), resolved = false, listener = () => {
                (resolved = true) && resolve(this);
            };
            if (this.path) {
                yield fs.ensureDir(path.dirname(this.path));
                if (yield fs.pathExists(this.path)) {
                    yield fs.unlink(this.path);
                }
                server.listen(util_1.absPath(this.path, true), listener);
            }
            else if (this.host) {
                server.listen(this.port, this.host, listener);
            }
            else {
                server.listen(this.port, listener);
            }
            server.once("error", err => {
                !resolved && (resolved = true) && reject(err);
            }).on("error", err => {
                if (this.errorHandler && resolved) {
                    this.errorHandler.call(this, err);
                }
            }).on("connection", socket => {
                let temp = [];
                socket.on("error", err => {
                    if (!isSocketResetError(err) && this.errorHandler) {
                        this.errorHandler(err);
                    }
                    else if (socket.destroyed) {
                        socket.emit("close", true);
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
                }).on("data", (buf) => tslib_1.__awaiter(this, void 0, void 0, function* () {
                    let msg = bsp_1.receive(buf, temp);
                    for (let [event, taskId, name, method, ...args] of msg) {
                        if (event === RpcEvents.HANDSHAKE) {
                            this.clients.set(taskId, socket);
                            this.dispatch(socket, RpcEvents.CONNECT);
                        }
                        else if (event === RpcEvents.REQUEST) {
                            let event, data;
                            try {
                                let ins = this.registry[name].instance(util_1.local);
                                data = yield ins[method](...args);
                                event = RpcEvents.RESPONSE;
                            }
                            catch (err) {
                                event = RpcEvents.ERROR;
                                data = util_1.err2obj(err);
                            }
                            this.dispatch(socket, event, taskId, data);
                        }
                    }
                }));
            });
        }));
    }
    close() {
        return new Promise(resolve => {
            if (this.server) {
                this.server.unref();
                this.server.close(() => resolve(this));
            }
            else {
                resolve(this);
            }
        });
    }
    register(mod) {
        this.registry[mod.name] = mod;
        return this;
    }
    publish(event, data, clients) {
        let sent = false;
        let socket;
        let targets = clients || this.clients.keys();
        for (let id of targets) {
            if (socket = this.clients.get(id)) {
                this.dispatch(socket, RpcEvents.BROADCAST, event, data);
                sent = true;
            }
        }
        return sent;
    }
    getClients() {
        let clients;
        this.clients.forEach((_, id) => clients.push(id));
        return clients;
    }
    dispatch(socket, ...data) {
        if (!socket.destroyed && socket.writable) {
            socket.write(bsp_1.send(...data));
        }
    }
}
exports.RpcServer = RpcServer;
class RpcClient extends RpcChannel {
    constructor(options, host) {
        super(options, host);
        this.connecting = false;
        this.connected = false;
        this.closed = false;
        this.initiated = false;
        this.registry = {};
        this.temp = [];
        this.taskId = 0;
        this.tasks = {};
        this.events = {};
        this.id = this.id || Math.random().toString(16).slice(2);
        this.timeout = this.timeout || 5000;
        this.socket = new net.Socket();
        this.socket.on("error", err => {
            if (this.connected && isSocketResetError(err)) {
                this.socket.emit("close", true);
            }
            else if (this.connected && this.errorHandler) {
                this.errorHandler(err);
            }
        }).on("end", () => {
            if (!this.connecting && this.socket.destroyed) {
                this.socket.emit("close", false);
            }
        }).on("close", hadError => {
            this.connected = false;
            this.pause();
            if (!this.closed && !this.connecting) {
                this.reconnect(hadError ? this.timeout : 0);
            }
        }).on("data", (buf) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            let msg = bsp_1.receive(buf, this.temp);
            for (let [event, taskId, data] of msg) {
                let task;
                switch (event) {
                    case RpcEvents.CONNECT:
                        this.finishConnect();
                        break;
                    case RpcEvents.BROADCAST:
                        let listeners = this.events[taskId] || [];
                        for (let handle of listeners) {
                            yield handle(data);
                        }
                        break;
                    case RpcEvents.RESPONSE:
                        if (task = this.tasks[taskId]) {
                            task.resolve(data);
                        }
                        break;
                    case RpcEvents.ERROR:
                        if (task = this.tasks[taskId]) {
                            task.reject(util_1.obj2err(data));
                        }
                        break;
                }
            }
        }));
    }
    open() {
        return new Promise((resolve, reject) => {
            if (this.socket.connecting || this.connected || this.closed) {
                return resolve(this);
            }
            this.connecting = true;
            let listener = () => {
                this.initiated = true;
                this.connected = !this.socket.destroyed;
                this.connecting = false;
                this.socket.removeListener("error", errorListener);
                this.finishConnect = () => resolve(this);
                this.send(RpcEvents.HANDSHAKE, this.id);
            };
            let errorListener = (err) => {
                this.connecting = false;
                this.socket.removeListener("connect", listener);
                if (this.initiated) {
                    this.socket.emit("close", !!err);
                    resolve(this);
                }
                else {
                    reject(err);
                }
            };
            if (this.path) {
                this.socket.connect(util_1.absPath(this.path, true));
            }
            else {
                this.socket.connect(this.port, this.host);
            }
            this.socket.once("connect", listener).once("error", errorListener);
        });
    }
    close() {
        return new Promise(resolve => {
            this.closed = true;
            this.connected = false;
            this.connecting = false;
            this.pause();
            if (this.socket) {
                this.socket.unref();
                this.socket.end();
                resolve(this);
            }
            else {
                resolve(this);
            }
        });
    }
    register(mod) {
        this.registry[mod.name] = mod;
        mod[util_1.remotized] = true;
        mod["remoteSingletons"][this.dsn] = util_1.createRemoteInstance(mod, (ins, prop) => {
            return this.createFunction(ins, mod.name, prop);
        });
        return this;
    }
    pause() {
        let { dsn } = this;
        let success = false;
        for (let name in this.registry) {
            let instances = this.registry[name]["remoteSingletons"];
            delete instances[dsn];
            success = true;
        }
        return success;
    }
    resume() {
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
    subscribe(event, listener) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(listener);
        return this;
    }
    unsubscribe(event, listener) {
        if (!listener) {
            return this.events[event] ? (delete this.events[event]) : false;
        }
        else if (this.events[event]) {
            let i = this.events[event].indexOf(listener);
            return this.events[event].splice(i, 1).length > 0;
        }
        else {
            return false;
        }
    }
    reconnect(timeout = 0) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (this.connected || this.connecting)
                return;
            try {
                this.connecting = true;
                timeout && (yield sleep(timeout));
                yield this.open();
            }
            catch (e) { }
            if (this.connected) {
                this.resume();
            }
        });
    }
    send(...data) {
        if (this.socket && !this.socket.destroyed && this.socket.writable) {
            this.socket.write(bsp_1.send(...data));
        }
    }
    getTaskId() {
        let taskId = this.taskId++;
        if (this.taskId === Number.MAX_SAFE_INTEGER)
            this.taskId = 0;
        return taskId;
    }
    createTask(resolve, reject) {
        let taskId = this.getTaskId();
        let timer = setTimeout(() => {
            let task = this.tasks[taskId];
            let num = Math.round(this.timeout / 1000);
            let unit = num === 1 ? "second" : "seconds";
            task.reject(new Error(`RPC request timeout after ${num} ${unit}`));
        }, this.timeout);
        let clean = () => {
            clearTimeout(timer);
            delete this.tasks[taskId];
            return true;
        };
        this.tasks[taskId] = {
            resolve: (res) => clean() && resolve(res),
            reject: (err) => clean() && reject(err)
        };
        return taskId;
    }
    createFunction(ins, name, method) {
        let self = this;
        let originMethod = ins[method];
        let fn = function (...args) {
            return new Promise((resolve, reject) => tslib_1.__awaiter(this, void 0, void 0, function* () {
                let taskId = self.createTask(resolve, reject);
                self.send(RpcEvents.REQUEST, taskId, name, method, ...args);
            }));
        };
        return util_1.mergeFnProperties(fn, originMethod);
    }
}
exports.RpcClient = RpcClient;
//# sourceMappingURL=rpc.js.map