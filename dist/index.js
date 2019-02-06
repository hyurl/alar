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
let ModuleProxy = ModuleProxy_1 = class ModuleProxy {
    constructor(name, path, singletons = {}) {
        this.name = name;
        this.singletons = singletons;
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
    get ctor() {
        let { path } = this;
        let mod = require.cache[path + ".ts"] || require.cache[path + ".js"];
        if (!mod) {
            mod = require(path);
            if (!mod.default || typeof mod.default !== "function") {
                throw new TypeError(`Module ${this.name} is not a constructor.`);
            }
        }
        else {
            mod = mod.exports;
        }
        return mod.default;
    }
    create(...args) {
        return new this.ctor(...args);
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
            if (ext === ".js" || ext === ".ts") {
                modPath = modPath.slice(0, -3);
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
                delete require.cache[filename];
                cb && cb(event, filename);
            }
        };
        return chokidar_1.watch(path, {
            persistent: false,
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
    __get(prop) {
        if (prop in this) {
            return this[prop];
        }
        else if (prop in this.children) {
            return this.children[prop];
        }
        else if (typeof prop != "symbol") {
            return (this.children[prop] = new ModuleProxy_1((this.name && `${this.name}.`) + String(prop), this.root.path, this.singletons));
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