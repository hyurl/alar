"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const net = require("net");
const path = require("path");
const fs = require("fs-extra");
const bsp_1 = require("bsp");
const isSocketResetError = require("is-socket-reset-error");
const util_1 = require("./util");
var RpcEvents;
(function (RpcEvents) {
    RpcEvents[RpcEvents["REQUEST"] = 0] = "REQUEST";
    RpcEvents[RpcEvents["RESPONSE"] = 1] = "RESPONSE";
    RpcEvents[RpcEvents["ERROR"] = 2] = "ERROR";
})(RpcEvents = exports.RpcEvents || (exports.RpcEvents = {}));
class RpcChannel {
    constructor(options, host) {
        this.host = "";
        this.port = 0;
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
            else if (!this.host) {
                server.listen(this.port, listener);
            }
            else {
                server.listen(this.port, this.host, listener);
            }
            server.once("error", err => {
                !resolved && reject(err);
            }).on("error", err => {
                if (this.errorHandler && resolved) {
                    this.errorHandler.call(this, err);
                }
            }).on("connection", socket => {
                let remains = [];
                socket.on("error", err => {
                    if (!isSocketResetError(err) && this.errorHandler) {
                        this.errorHandler.call(this, err);
                    }
                }).on("data", (buf) => tslib_1.__awaiter(this, void 0, void 0, function* () {
                    let msg = bsp_1.receive(buf, remains);
                    for (let [event, taskId, name, method, ...args] of msg) {
                        if (event === RpcEvents.REQUEST) {
                            let event = RpcEvents.RESPONSE, data;
                            try {
                                let ins = this.registry[name].instance();
                                event = RpcEvents.RESPONSE;
                                data = yield ins[method](...args);
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
            this.server ? this.server.close(() => {
                this.server.unref();
                resolve(this);
            }) : resolve(this);
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
        this.queue = [];
        this.taskId = 0;
        this.tasks = {};
    }
    open() {
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
                    this.socket = net.createConnection(util_1.absPath(this.path, true), listener);
                }
                else {
                    this.socket = net.createConnection(this.port, this.host, listener);
                }
            };
            let remains = [];
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
                            }
                            else if (times === maxTimes) {
                                clearTimeout(timer);
                                this.errorHandler.call(this, err);
                            }
                            else {
                                reconnect();
                            }
                        }, 50);
                    };
                }
                else if (this.errorHandler && resolved) {
                    this.errorHandler.call(this, err);
                }
            }).on("data", buf => {
                let msg = bsp_1.receive(buf, remains);
                for (let [event, taskId, data] of msg) {
                    if (this.tasks[taskId]) {
                        if (event === RpcEvents.RESPONSE) {
                            this.tasks[taskId].resolve(data);
                        }
                        else if (event === RpcEvents.ERROR) {
                            this.tasks[taskId].reject(util_1.obj2err(data));
                        }
                    }
                }
            });
        });
    }
    close() {
        return new Promise(resolve => {
            if (this.socket) {
                this.socket.destroy();
                this.socket.unref();
                resolve(this);
            }
            else {
                resolve(this);
            }
        });
    }
    register(mod) {
        let ins = new Proxy(mod.create(), {
            get: (ins, prop) => {
                if (typeof ins[prop] === "function" && !ins[prop].proxified) {
                    util_1.set(ins, prop, this.createFunction(ins, mod.name, prop));
                }
                return ins[prop];
            }
        });
        mod["remoteSingletons"].push(ins);
        return this;
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
    createFunction(ins, name, method) {
        let $this = this;
        let originMethod = ins[method];
        let fn = function (...args) {
            return new Promise((resolve, reject) => {
                let taskId = $this.getTaskId();
                let { timeout } = $this;
                let timer = setTimeout(() => {
                    let num = Math.round(timeout / 1000), unit = num === 1 ? "second" : "seconds";
                    delete $this.tasks[taskId];
                    reject(new Error(`RPC request timeout after ${num} ${unit}`));
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