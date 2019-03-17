"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const net = require("net");
const path = require("path");
const fs = require("fs-extra");
const bsp_1 = require("bsp");
const thenable_generator_1 = require("thenable-generator");
const isSocketResetError = require("is-socket-reset-error");
const sleep = require("sleep-promise");
const sequid_1 = require("sequid");
const util_1 = require("./util");
var RpcEvents;
(function (RpcEvents) {
    RpcEvents[RpcEvents["HANDSHAKE"] = 0] = "HANDSHAKE";
    RpcEvents[RpcEvents["CONNECT"] = 1] = "CONNECT";
    RpcEvents[RpcEvents["BROADCAST"] = 2] = "BROADCAST";
    RpcEvents[RpcEvents["AWAIT"] = 3] = "AWAIT";
    RpcEvents[RpcEvents["RETURN"] = 4] = "RETURN";
    RpcEvents[RpcEvents["YIELD"] = 5] = "YIELD";
    RpcEvents[RpcEvents["THROW"] = 6] = "THROW";
    RpcEvents[RpcEvents["PING"] = 7] = "PING";
    RpcEvents[RpcEvents["PONG"] = 8] = "PONG";
})(RpcEvents || (RpcEvents = {}));
class RpcChannel {
    constructor(options, host) {
        this.host = "0.0.0.0";
        this.port = 9000;
        this.path = "";
        this.timeout = 5000;
        this.pingTimeout = 1000 * 30;
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
        this.activeClients = new Map();
        this.authorizedClients = new Map();
        this.suspendedTasks = new Map();
        this.gcTimer = setInterval(() => {
            let now = Date.now();
            let timeout = this.pingTimeout + 100;
            for (let [socket, activeTime] of this.activeClients) {
                if (now - activeTime >= timeout) {
                    this.refuceConnect(socket, "Connection reset due to long-time inactive");
                }
            }
        }, this.timeout);
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
            }).on("connection", this.handleConnection.bind(this));
        }));
    }
    close() {
        return new Promise(resolve => {
            if (this.server) {
                clearInterval(this.gcTimer);
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
        let now = Date.now();
        let timeout = this.pingTimeout + 100;
        for (let [id, socket] of this.clients) {
            let activeTime = this.activeClients.get(socket);
            if (activeTime && now - activeTime < timeout) {
                clients.push(id);
            }
        }
        return clients;
    }
    dispatch(socket, ...data) {
        if (!socket.destroyed && socket.writable) {
            socket.write(bsp_1.send(...data));
        }
    }
    refuceConnect(socket, reason) {
        socket.destroy(new Error(reason || "UnauthorizedClients connection"));
    }
    handleConnection(socket) {
        let temp = [];
        socket.on("error", err => {
            if (!isSocketResetError(err) && this.errorHandler) {
                this.errorHandler(err);
            }
        }).on("end", () => {
            socket.emit("close", false);
        }).on("close", () => {
            for (let [id, _socket] of this.clients) {
                if (Object.is(_socket, socket)) {
                    this.clients.delete(id);
                    this.activeClients.delete(socket);
                    this.authorizedClients.delete(socket);
                    break;
                }
            }
        }).on("data", (buf) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            let msg = bsp_1.receive(buf, temp);
            for (let [event, taskId, name, method, ...args] of msg) {
                if (event !== RpcEvents.HANDSHAKE && !this.authorizedClients.get(socket)) {
                    return this.refuceConnect(socket);
                }
                else {
                    this.activeClients.set(socket, Date.now());
                }
                switch (event) {
                    case RpcEvents.HANDSHAKE:
                        if ((!name && !this.secret) || name === this.secret) {
                            this.clients.set(taskId, socket);
                            this.authorizedClients.set(socket, true);
                            this.suspendedTasks.set(socket, {});
                            this.dispatch(socket, RpcEvents.CONNECT, name);
                        }
                        else {
                            this.refuceConnect(socket);
                        }
                        break;
                    case RpcEvents.PING:
                        this.dispatch(socket, RpcEvents.PONG);
                        break;
                    case RpcEvents.AWAIT:
                        {
                            let event, data;
                            let tasks = this.suspendedTasks.get(socket) || {};
                            let task = tasks[taskId];
                            try {
                                if (task) {
                                    delete tasks[taskId];
                                }
                                else {
                                    let ins = this.registry[name].instance(util_1.local);
                                    let source = ins[method](...args);
                                    task = new thenable_generator_1.ThenableAsyncGenerator(source);
                                }
                                data = yield task;
                                event = RpcEvents.RETURN;
                            }
                            catch (err) {
                                event = RpcEvents.THROW;
                                data = util_1.err2obj(err);
                            }
                            this.dispatch(socket, event, taskId, data);
                        }
                        break;
                    case RpcEvents.YIELD:
                    case RpcEvents.RETURN:
                    case RpcEvents.THROW:
                        {
                            let data, input = args[0];
                            let tasks = this.suspendedTasks.get(socket) || {};
                            let task = tasks[taskId];
                            let res;
                            try {
                                if (!task) {
                                    let ins = this.registry[name].instance(util_1.local);
                                    let source = ins[method](...args);
                                    task = new thenable_generator_1.ThenableAsyncGenerator(source);
                                    tasks[taskId] = task;
                                }
                                if (event === RpcEvents.YIELD) {
                                    res = yield task.next(input);
                                }
                                else if (event === RpcEvents.RETURN) {
                                    res = yield task.return(input);
                                }
                                else {
                                    yield task.throw(input);
                                }
                            }
                            catch (err) {
                                res = { value: util_1.err2obj(err), done: true };
                            }
                            data = res.value;
                            res.done && task && (delete tasks[taskId]);
                            this.dispatch(socket, event, taskId, data);
                        }
                        break;
                }
            }
        }));
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
        this.taskId = sequid_1.default(0, true);
        this.tasks = {};
        this.events = {};
        this.finishConnect = null;
        this.selfDestruction = null;
        this.pingTimer = setInterval(() => {
            this.selfDestruction = setTimeout(() => {
                this.socket.destroy();
            }, this.timeout);
            this.send(RpcEvents.PING, this.id);
        }, this.pingTimeout);
        this.id = this.id || Math.random().toString(16).slice(2);
        this.socket = new net.Socket();
        this.socket.on("error", err => {
            if (this.connected && !isSocketResetError(err) && this.errorHandler) {
                this.errorHandler(err);
            }
        }).on("end", () => {
            if (!this.connecting && this.socket.destroyed) {
                this.socket.emit("close", false);
            }
        }).on("close", hadError => {
            this.connected = false;
            this.pause();
            if (!this.closed && !this.connecting && this.initiated) {
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
                    case RpcEvents.YIELD:
                    case RpcEvents.RETURN:
                        if (task = this.tasks[taskId]) {
                            task.resolve(data);
                        }
                        break;
                    case RpcEvents.THROW:
                        if (task = this.tasks[taskId]) {
                            task.reject(util_1.obj2err(data));
                        }
                        break;
                    case RpcEvents.PONG:
                        clearTimeout(this.selfDestruction);
                        this.selfDestruction = null;
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
                this.connecting = false;
                this.socket.removeListener("error", errorListener);
                this.finishConnect = () => {
                    this.connected = true;
                    resolve(this);
                };
                this.send(RpcEvents.HANDSHAKE, this.id, this.secret);
            };
            let errorListener = (err) => {
                this.connecting = false;
                this.socket.removeListener("connect", listener);
                if (this.initiated) {
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
            clearInterval(this.pingTimer);
            clearTimeout(this.selfDestruction);
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
    createTimeout(reject) {
        return setTimeout(() => {
            let num = Math.round(this.timeout / 1000);
            let unit = num === 1 ? "second" : "seconds";
            reject(new Error(`RPC request timeout after ${num} ${unit}`));
        }, this.timeout);
    }
    ;
    prepareTask(taskId) {
        let task = this.tasks[taskId];
        if (!task) {
            task = this.tasks[taskId] = {};
        }
        return new Promise((resolve, reject) => {
            let timer = this.createTimeout(reject);
            task.resolve = (data) => {
                clearTimeout(timer);
                resolve(data);
            };
            task.reject = (err) => {
                clearTimeout(timer);
                reject(err);
            };
        });
    }
    createFunction(ins, name, method) {
        let self = this;
        let originMethod = ins[method];
        let fn = function (...args) {
            let taskId = self.taskId.next().value;
            return new thenable_generator_1.ThenableAsyncGenerator({
                next(value) {
                    self.send(RpcEvents.YIELD, taskId, name, method, value);
                    return self.prepareTask(taskId);
                },
                return(value) {
                    self.send(RpcEvents.RETURN, taskId, name, method, value);
                    return self.prepareTask(taskId);
                },
                throw(err) {
                    self.send(RpcEvents.THROW, taskId, name, method, util_1.err2obj(err));
                    return self.prepareTask(taskId);
                },
                then(resolver, rejecter) {
                    self.send(RpcEvents.AWAIT, taskId, name, method, ...args);
                    return self.prepareTask(taskId).then(resolver, rejecter);
                }
            });
        };
        return util_1.mergeFnProperties(fn, originMethod);
    }
}
exports.RpcClient = RpcClient;
//# sourceMappingURL=rpc.js.map