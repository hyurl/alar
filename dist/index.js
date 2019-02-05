"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
var ModuleProxy_1;
const path = require("path");
const js_magic_1 = require("js-magic");
const chokidar_1 = require("chokidar");
const hash = require("string-hash");
const objHash = require("object-hash");
const startsWith = require("lodash/startsWith");
const rpc_1 = require("./rpc");
exports.RpcChannel = rpc_1.RpcChannel;
let ModuleProxy = ModuleProxy_1 = class ModuleProxy {
    constructor(name, root, singletons = {}) {
        this.name = name;
        this.singletons = singletons;
        this.remoteSingletons = [];
        this.children = {};
        this.root = path.normalize(root);
    }
    get path() {
        return path.resolve(this.root, ...this.name.split(".").slice(1));
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
        else if (typeof this.ctor.getInstance === "function") {
            return (this.singletons[this.name] = this.ctor.getInstance());
        }
        else {
            try {
                ins = this.create();
            }
            catch (err) {
                ins = Object.create(this.ctor.prototype);
            }
            return (this.singletons[this.name] = ins);
        }
    }
    remote(route = "") {
        let id = hash(objHash(route)) % this.remoteSingletons.length;
        return this.remoteSingletons[id];
    }
    serve(config) {
        return new rpc_1.RpcServer(config).open();
    }
    connect(config) {
        return new rpc_1.RpcClient(config).open();
    }
    watch() {
        let { root } = this;
        let pathToName = (filename) => {
            return filename.slice(root.length + 1, -3).replace(/\\|\//g, ".");
        };
        let clearCache = (filename) => {
            let ext = path.extname(filename);
            if (ext === ".js" || ext === ".ts") {
                delete this.singletons[pathToName(filename)];
                delete require.cache[filename];
            }
        };
        return chokidar_1.watch(root, {
            awaitWriteFinish: true,
            followSymlinks: false
        }).on("change", clearCache)
            .on("unlink", clearCache)
            .on("unlinkDir", dirname => {
            dirname = dirname + path.sep;
            for (let filename in require.cache) {
                if (startsWith(filename, dirname)) {
                    delete this.singletons[pathToName(filename)];
                    delete require.cache[filename];
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
            return (this.children[prop] = new ModuleProxy_1((this.name && `${this.name}.`) + String(prop), this.root, this.singletons));
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