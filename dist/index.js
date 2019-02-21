"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
var ModuleProxy_1;
const path_1 = require("path");
const js_magic_1 = require("js-magic");
const chokidar_1 = require("chokidar");
exports.FSWatcher = chokidar_1.FSWatcher;
const hash = require("string-hash");
const objHash = require("object-hash");
const startsWith = require("lodash/startsWith");
const rpc_1 = require("./rpc");
exports.RpcChannel = rpc_1.RpcChannel;
const util_1 = require("./util");
const isTsNode = process.execArgv.join(" ").includes("ts-node");
const defaultLoader = {
    extesion: isTsNode ? ".ts" : ".js",
    load: require,
    unload(path) {
        delete require.cache[path + this.extesion];
    }
};
let ModuleProxy = ModuleProxy_1 = class ModuleProxy {
    constructor(name, path) {
        this.name = name;
        this.loader = defaultLoader;
        this.singletons = {};
        this.remoteSingletons = {};
        this.children = {};
        this.root = {
            name: name.split(".")[0],
            path: path_1.normalize(path)
        };
    }
    get path() {
        return path_1.resolve(this.root.path, ...this.name.split(".").slice(1));
    }
    get exports() {
        return this.loader.load(this.path);
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
    instance(ins) {
        if (ins) {
            return (this.singletons[this.name] = ins);
        }
        else if (this.singletons[this.name]) {
            return this.singletons[this.name];
        }
        else {
            return (this.singletons[this.name] = util_1.getInstance(this));
        }
    }
    remote(route = "") {
        let keys = Object.keys(this.remoteSingletons);
        let id = keys[hash(objHash(route)) % keys.length];
        return this.remoteSingletons[id];
    }
    serve(config) {
        return new rpc_1.RpcServer(config).open();
    }
    connect(config) {
        return new rpc_1.RpcClient(config).open();
    }
    resolve(path) {
        let rootPath = this.root.path + path_1.sep;
        if (startsWith(path, rootPath)) {
            let modPath = path.slice(rootPath.length), ext = path_1.extname(modPath);
            if (ext === this.loader.extesion) {
                modPath = modPath.slice(0, -this.loader.extesion.length);
            }
            else if (ext) {
                return;
            }
            return this.root.name + "." + modPath.replace(/\\|\//g, ".");
        }
        else {
            return;
        }
    }
    watch(listener) {
        let { path } = this.root;
        let clearCache = (event, filename, cb) => {
            let name = this.resolve(filename);
            if (name) {
                delete this.singletons[name];
                this.loader.unload(filename.slice(0, -this.loader.extesion.length));
                cb && cb(event, filename);
            }
        };
        return chokidar_1.watch(path, {
            awaitWriteFinish: true,
            followSymlinks: false
        }).on("change", (filename) => {
            clearCache("change", filename, listener);
        }).on("unlink", (filename) => {
            clearCache("unlink", filename, listener);
        }).on("unlinkDir", dirname => {
            dirname = dirname + path_1.sep;
            for (let filename in require.cache) {
                if (startsWith(filename, dirname)) {
                    clearCache("unlink", filename, listener);
                }
            }
        });
    }
    setLoader(loader) {
        this.loader = loader;
    }
    __get(prop) {
        if (prop in this) {
            return this[prop];
        }
        else if (prop in this.children) {
            return this.children[prop];
        }
        else if (typeof prop != "symbol") {
            this.children[prop] = new ModuleProxy_1((this.name && `${this.name}.`) + String(prop), this.root.path);
            this.children[prop].singletons = this.singletons;
            this.children[prop].loader = this.loader;
            return this.children[prop];
        }
    }
    __has(prop) {
        return (prop in this) || (prop in this.children);
    }
};
ModuleProxy = ModuleProxy_1 = tslib_1.__decorate([
    js_magic_1.applyMagic
], ModuleProxy);
exports.ModuleProxy = ModuleProxy;
exports.default = ModuleProxy;
//# sourceMappingURL=index.js.map