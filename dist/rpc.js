"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const net = require("net");
const path = require("path");
const fs = require("fs-extra");
const bsp_1 = require("bsp");
const advanced_collections_1 = require("advanced-collections");
const isSocketResetError = require("is-socket-reset-error");
const sleep = require("sleep-promise");
const sequid_1 = require("sequid");
const isIteratorLike = require("is-iterator-like");
const thenable_generator_1 = require("thenable-generator");
const util_1 = require("./util");
const authorized = Symbol("authorized");
const lastActiveTime = Symbol("lastActiveTime");
var RpcEvents;
(function (RpcEvents) {
    RpcEvents[RpcEvents["HANDSHAKE"] = 0] = "HANDSHAKE";
    RpcEvents[RpcEvents["CONNECT"] = 1] = "CONNECT";
    RpcEvents[RpcEvents["BROADCAST"] = 2] = "BROADCAST";
    RpcEvents[RpcEvents["INVOKE"] = 3] = "INVOKE";
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
    static registerError(ctor) {
        util_1.Errors[ctor.name] = ctor;
    }
}
exports.RpcChannel = RpcChannel;
class RpcServer extends RpcChannel {
    constructor() {
        super(...arguments);
        this.registry = {};
        this.clients = new advanced_collections_1.BiMap();
        this.suspendedTasks = new Map();
        this.gcTimer = setInterval(() => {
            let now = Date.now();
            let timeout = this.pingTimeout + 5;
            for (let [, socket] of this.clients) {
                if (now - socket[lastActiveTime] > timeout) {
                    socket.destroy();
                }
            }
        }, this.timeout);
    }
    open() {
        return new Promise((resolve, reject) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            let server = this.server = net.createServer();
            let listener = () => {
                resolve(this);
                server.on("error", err => {
                    this.errorHandler && this.errorHandler.call(this, err);
                });
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
            server.once("error", reject)
                .on("connection", this.handleConnection.bind(this));
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
        let clients = [];
        let now = Date.now();
        for (let [id, socket] of this.clients) {
            if (now - socket[lastActiveTime] <= this.pingTimeout) {
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
    handleConnection(socket) {
        let temp = [];
        socket.on("error", err => {
            if (!isSocketResetError(err) && this.errorHandler) {
                this.errorHandler(err);
            }
        }).on("end", () => {
            socket.emit("close", false);
        }).on("close", () => {
            this.clients.deleteValue(socket);
            let tasks = this.suspendedTasks.get(socket);
            this.suspendedTasks.delete(socket);
            for (let id in tasks) {
                tasks[id].return();
            }
        }).on("data", (buf) => tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (!socket[authorized]) {
                if (this.secret) {
                    let index = buf.indexOf("\r\n");
                    let secret = buf.slice(0, index).toString();
                    if (secret !== this.secret) {
                        return socket.destroy();
                    }
                    else {
                        buf = buf.slice(index + 2);
                    }
                }
                socket[authorized] = true;
            }
            socket[lastActiveTime] = Date.now();
            let msg = bsp_1.receive(buf, temp);
            for (let [event, taskId, name, method, ...args] of msg) {
                switch (event) {
                    case RpcEvents.HANDSHAKE:
                        this.clients.set(taskId, socket);
                        this.suspendedTasks.set(socket, {});
                        this.dispatch(socket, RpcEvents.CONNECT);
                        break;
                    case RpcEvents.PING:
                        this.dispatch(socket, RpcEvents.PONG);
                        break;
                    case RpcEvents.INVOKE:
                        {
                            let data;
                            let tasks = this.suspendedTasks.get(socket) || {};
                            try {
                                let ins = this.registry[name].instance(util_1.local);
                                let task = ins[method].apply(ins, args);
                                if (task && isIteratorLike(task[thenable_generator_1.source])) {
                                    tasks[taskId] = task;
                                    event = RpcEvents.INVOKE;
                                }
                                else {
                                    data = yield task;
                                    event = RpcEvents.RETURN;
                                }
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
                            let data, input;
                            let tasks = this.suspendedTasks.get(socket) || {};
                            let task = tasks[taskId];
                            try {
                                if (!task) {
                                    throw new ReferenceError(`task (${taskId}) doesn't exist`);
                                }
                                else {
                                    input = args[0];
                                }
                                if (event === RpcEvents.YIELD) {
                                    data = yield task.next(input);
                                }
                                else if (event === RpcEvents.RETURN) {
                                    data = yield task.return(input);
                                }
                                else {
                                    yield task.throw(input);
                                }
                                data.done && (delete tasks[taskId]);
                            }
                            catch (err) {
                                event = RpcEvents.THROW;
                                data = util_1.err2obj(err);
                                task && (delete tasks[taskId]);
                            }
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
                    case RpcEvents.INVOKE:
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
                this.socket.write((this.secret || "") + "\r\n", () => {
                    this.send(RpcEvents.HANDSHAKE, this.id);
                });
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
        mod["remoteSingletons"][this.dsn] = util_1.createRemoteInstance(mod, (prop) => {
            return this.createFunction(mod.name, prop);
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
    send(...data) {
        if (this.socket && !this.socket.destroyed && this.socket.writable) {
            if (data[data.length - 1] === undefined) {
                data.pop();
            }
            this.socket.write(bsp_1.send(...data));
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
    createFunction(name, method) {
        let self = this;
        return function (...args) {
            return new thenable_generator_1.ThenableAsyncGenerator(new ThenableIteratorProxy(self, name, method, ...args));
        };
    }
}
exports.RpcClient = RpcClient;
class ThenableIteratorProxy {
    constructor(client, name, method, ...args) {
        this.client = client;
        this.name = name;
        this.method = method;
        this.taskId = this.client["taskId"].next().value;
        this.queue = [];
        this.status = "uninitiated";
        this.args = args;
        this.result = this.invokeTask(RpcEvents.INVOKE, ...this.args);
    }
    next(value) {
        return this.invokeTask(RpcEvents.YIELD, value);
    }
    return(value) {
        return this.invokeTask(RpcEvents.RETURN, value);
    }
    throw(err) {
        return this.invokeTask(RpcEvents.THROW, util_1.err2obj(err));
    }
    then(resolver, rejecter) {
        return Promise.resolve(this.result).then((res) => {
            this.status = "closed";
            this.result = res;
            delete this.client["tasks"][this.taskId];
            return res;
        }).then(resolver, rejecter);
    }
    close() {
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
    createTimeout() {
        return setTimeout(() => {
            let num = Math.round(this.client.timeout / 1000);
            let unit = num === 1 ? "second" : "seconds";
            if (this.queue.length > 0) {
                this.queue.shift().reject(new Error(`RPC request timeout after ${num} ${unit}`));
            }
            this.close();
        }, this.client.timeout);
    }
    prepareTask(event, data) {
        let task = this.client["tasks"][this.taskId];
        if (!task) {
            task = this.client["tasks"][this.taskId] = {
                resolve: (data) => {
                    if (this.status === "suspended") {
                        if (this.queue.length > 0) {
                            this.queue.shift().resolve(data);
                        }
                    }
                },
                reject: (err) => {
                    if (this.status === "suspended") {
                        if (this.queue.length > 0) {
                            this.queue.shift().reject(err);
                        }
                        this.close();
                    }
                }
            };
        }
        return new Promise((resolve, reject) => {
            let timer = this.createTimeout();
            this.queue.push({
                event,
                data,
                resolve: (data) => {
                    clearTimeout(timer);
                    resolve(data);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }
    invokeTask(event, ...args) {
        if (this.status === "closed") {
            switch (event) {
                case RpcEvents.INVOKE:
                    return Promise.resolve(this.result);
                case RpcEvents.YIELD:
                    return Promise.resolve({ value: undefined, done: true });
                case RpcEvents.RETURN:
                    return Promise.resolve({ value: args[0], done: true });
                case RpcEvents.THROW:
                    return Promise.reject(util_1.obj2err(args[0]));
            }
        }
        else {
            if (this.status === "uninitiated" && event !== RpcEvents.INVOKE) {
                this.client.send(event, this.taskId, this.name, this.method, [...this.args], ...args);
            }
            else {
                this.client.send(event, this.taskId, this.name, this.method, ...args);
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
//# sourceMappingURL=rpc.js.map