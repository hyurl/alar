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
})(RpcEvents || (RpcEvents = {}));
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
        this.temp = [];
        this.taskId = 0;
        this.tasks = {};
    }
    init() {
        this.socket = new net.Socket();
        this.socket.on("error", err => {
            if (this.connected && isSocketResetError(err)) {
                this.socket.emit("close", !!err);
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
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                this.init();
            }
            else if (this.socket.connecting || this.connected || this.closed) {
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
            if (this.closed || Object.keys(instances).length > 1) {
                delete instances[dsn];
                success = true;
            }
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
        if (this.socket && !this.socket.destroyed) {
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