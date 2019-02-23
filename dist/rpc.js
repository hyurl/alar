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
    RpcEvents[RpcEvents["REQUEST"] = 0] = "REQUEST";
    RpcEvents[RpcEvents["RESPONSE"] = 1] = "RESPONSE";
    RpcEvents[RpcEvents["ERROR"] = 2] = "ERROR";
})(RpcEvents = exports.RpcEvents || (exports.RpcEvents = {}));
class RpcChannel {
    constructor(options, host) {
        this.host = "0.0.0.0";
        this.port = 9000;
        this.path = "";
        this.timeout = 5000;
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
                }).on("data", (buf) => tslib_1.__awaiter(this, void 0, void 0, function* () {
                    let msg = bsp_1.receive(buf, temp);
                    for (let [event, taskId, name, method, ...args] of msg) {
                        if (event === RpcEvents.REQUEST) {
                            let event, data;
                            try {
                                let ins = this.registry[name].instance();
                                data = yield ins[method](...args);
                                event = RpcEvents.RESPONSE;
                            }
                            catch (err) {
                                event = RpcEvents.ERROR;
                                data = util_1.err2obj(err);
                            }
                            socket.write(bsp_1.send(event, taskId, data));
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
}
exports.RpcServer = RpcServer;
class RpcClient extends RpcChannel {
    constructor() {
        super(...arguments);
        this.connecting = false;
        this.connected = false;
        this.closed = false;
        this.initiated = false;
        this.registry = {};
        this.queue = [];
        this.temp = [];
        this.taskId = 0;
        this.tasks = {};
    }
    init() {
        this.socket = new net.Socket();
        this.socket.on("error", err => {
            if (err["code"] === "EALREADY") {
                return;
            }
            else if (this.connected && isSocketResetError(err)) {
                this.socket.emit("close", !!err);
            }
            else if (this.connected && this.errorHandler) {
                this.errorHandler(err);
            }
        }).on("end", () => {
            !this.connecting && this.socket.emit("close", false);
        }).on("close", () => {
            this.connected = false;
            this.stop();
            if (!this.closed && !this.connecting) {
                this.connecting = true;
                this.reconnect(this.timeout);
            }
        }).on("data", buf => {
            let msg = bsp_1.receive(buf, this.temp);
            for (let [event, taskId, data] of msg) {
                let task = this.tasks[taskId];
                if (task) {
                    if (event === RpcEvents.RESPONSE) {
                        task.resolve(data);
                    }
                    else if (event === RpcEvents.ERROR) {
                        task.reject(util_1.obj2err(data));
                    }
                }
            }
        });
    }
    open() {
        this.connecting = true;
        return new Promise((resolve, reject) => {
            if (this.closed)
                return resolve(this);
            if (this.socket) {
                this.socket.removeAllListeners("connect");
            }
            else {
                this.init();
            }
            let listener = () => {
                this.initiated = true;
                this.connected = true;
                this.connecting = false;
                resolve(this);
                while (this.queue.length) {
                    this.send(...this.queue.shift());
                }
            };
            if (this.path) {
                this.socket.connect(util_1.absPath(this.path, true), listener);
            }
            else {
                this.socket.connect(this.port, this.host, listener);
            }
            this.socket.once("error", err => {
                if (this.connecting) {
                    this.connecting = false;
                    if (err["code"] === "EALREADY") {
                        listener();
                        this.continue();
                    }
                    else if (this.initiated) {
                        this.initiated = true;
                        this.socket.emit("close", !!err);
                        resolve(this);
                    }
                    else {
                        reject(err);
                    }
                }
            });
        });
    }
    close() {
        return new Promise(resolve => {
            this.closed = true;
            this.connected = false;
            this.connecting = false;
            this.stop();
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
        mod["remoteSingletons"][this.dsn] = new Proxy(util_1.getInstance(mod, false), {
            get: (ins, prop) => {
                let isFn = typeof ins[prop] === "function";
                if (isFn && !ins[prop].proxified) {
                    util_1.set(ins, prop, this.createFunction(ins, mod.name, prop));
                }
                return isFn ? ins[prop] : undefined;
            },
            has: (ins, prop) => {
                return typeof ins[prop] === "function";
            }
        });
        return this;
    }
    stop() {
        let { dsn } = this;
        for (let name in this.registry) {
            let instances = this.registry[name]["remoteSingletons"];
            if (Object.keys(instances).length > 1) {
                delete instances[dsn];
            }
        }
    }
    continue() {
        let { dsn } = this;
        for (let name in this.registry) {
            let instances = this.registry[name]["remoteSingletons"];
            if (!instances[dsn]) {
                this.register(this.registry[name]);
            }
        }
    }
    reconnect(timeout = 0) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (this.connected)
                return;
            try {
                timeout && (yield sleep(timeout));
                yield this.open();
            }
            finally {
                if (this.connected) {
                    this.continue();
                }
            }
        });
    }
    send(...data) {
        if (this.socket && !this.socket.destroyed) {
            this.socket.write(bsp_1.send(...data));
        }
        else {
            this.queue.push(data);
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
            let num = Math.round(this.timeout / 1000), unit = num === 1 ? "second" : "seconds";
            this.tasks[taskId].reject(new Error(`RPC request timeout after ${num} ${unit}`));
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
                if (!self.connecting && !self.connected && !self.closed) {
                    self.connecting = true;
                    yield self.reconnect();
                }
                self.send(RpcEvents.REQUEST, taskId, name, method, ...args);
            }));
        };
        util_1.set(fn, "proxified", true);
        util_1.set(fn, "name", method);
        util_1.set(fn, "length", originMethod.length);
        util_1.set(fn, "toString", function toString() {
            return Function.prototype.toString.call(originMethod);
        }, true);
        return fn;
    }
}
exports.RpcClient = RpcClient;
//# sourceMappingURL=rpc.js.map