"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
var ModuleProxyBase_1;
const hash = require("string-hash");
const objectHash = require("object-hash");
const path_1 = require("path");
const js_magic_1 = require("js-magic");
const util_1 = require("./util");
const isTsNode = process.execArgv.join(" ").includes("ts-node");
const defaultLoader = {
    extesion: isTsNode ? ".ts" : ".js",
    load: require,
    unload(filename) {
        delete require.cache[filename];
    }
};
let ModuleProxyBase = ModuleProxyBase_1 = class ModuleProxyBase {
    constructor(name, path) {
        this.name = name;
        this.loader = defaultLoader;
        this.singletons = {};
        this.remoteSingletons = {};
        this.children = {};
        this.path = path_1.normalize(path);
    }
    get exports() {
        return this.loader.load(this.path + this.loader.extesion);
    }
    get proto() {
        let { exports } = this;
        if (typeof exports.default === "object")
            return exports.default;
        else if (typeof exports.default === "function")
            return exports.default.prototype;
        else if (typeof exports === "object")
            return exports;
        else if (typeof exports === "function")
            return exports.prototype;
        else
            return null;
    }
    get ctor() {
        let { exports } = this;
        if (typeof exports.default === "function")
            return exports.default;
        else if (typeof exports === "function")
            return exports;
        else
            return null;
    }
    create(...args) {
        if (this.ctor) {
            return new this.ctor(...args);
        }
        else if (this.proto) {
            return Object.create(this.proto);
        }
        else {
            throw new TypeError(`${this.name} is not a valid module.`);
        }
    }
    instance(route = "") {
        let keys = Object.keys(this.remoteSingletons);
        if (route === util_1.local || !this[util_1.remotized] || (!keys.length && !this[util_1.noLocal])) {
            return this.singletons[this.name] || (this.singletons[this.name] = util_1.getInstance(this));
        }
        else if (keys.length) {
            let id = keys[hash(objectHash(route)) % keys.length];
            return this.remoteSingletons[id];
        }
        else {
            throw new ReferenceError("RPC service is not available.");
        }
    }
    noLocal() {
        this[util_1.noLocal] = true;
        return this;
    }
    remote(route = "") {
        process.emitWarning("ModuleProxy<T>.route() has been deprecated, use ModuleProxy<T>.instance() instead");
        return this.instance(route);
    }
    __get(prop) {
        if (prop in this) {
            return this[prop];
        }
        else if (prop in this.children) {
            return this.children[prop];
        }
        else if (typeof prop != "symbol") {
            let child = new ModuleProxyBase_1(this.name + "." + String(prop), this.path + path_1.sep + String(prop));
            child.singletons = this.singletons;
            child.loader = this.loader;
            return this.children[prop] = child;
        }
    }
    __has(prop) {
        return (prop in this) || (prop in this.children);
    }
};
ModuleProxyBase = ModuleProxyBase_1 = tslib_1.__decorate([
    js_magic_1.applyMagic
], ModuleProxyBase);
exports.ModuleProxyBase = ModuleProxyBase;
//# sourceMappingURL=proxy.js.map