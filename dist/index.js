"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
var ModuleProxy_1;
const path = require("path");
const js_magic_1 = require("js-magic");
const chokidar_1 = require("chokidar");
const asrpc_1 = require("asrpc");
const hash = require("string-hash");
const objHash = require("object-hash");
const startsWith = require("lodash/startsWith");
let ModuleProxy = ModuleProxy_1 = class ModuleProxy {
    constructor(name, root, singletons = {}, remoteSingletons = {}, serviceInstances = {}) {
        this.name = name;
        this.singletons = singletons;
        this.remoteSingletons = remoteSingletons;
        this.serviceInstances = serviceInstances;
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
                throw new TypeError(`Module ${this.name} is not a constructor`);
            }
        }
        else {
            mod = mod.exports;
        }
        return mod.default;
    }
    instance(ins) {
        if (ins) {
            return (this.singletons[this.name] = ins);
        }
        else if (this.singletons[this.name]) {
            return this.singletons[this.name];
        }
        else if (typeof this.ctor["getInstance"] === "function") {
            return (this.singletons[this.name] = this.ctor["getInstance"]());
        }
        else {
            try {
                return new this.ctor();
            }
            catch (err) {
                return Object.create(this.ctor.prototype);
            }
        }
    }
    create(...args) {
        return new this.ctor(...args);
    }
    serve(server) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            let id = objHash(server), ins = this.serviceInstances[id];
            if (!ins) {
                ins = this.serviceInstances[id] = asrpc_1.createInstance(server);
                yield ins.start();
            }
            ins.register(this.ctor);
        });
    }
    connect(server) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            let id = objHash(server), ins = this.serviceInstances[id];
            if (!ins) {
                ins = this.serviceInstances[id] = asrpc_1.createInstance(server);
            }
            yield ins.connect(this.ctor);
            this.remoteSingletons[this.name].push(ins);
        });
    }
    remote(route = "") {
        let id = hash(objHash(route)) % this.remoteSingletons[this.name].length;
        return this.remoteSingletons[this.name][id];
    }
    watch() {
        if (ModuleProxy_1.watchers[this.root])
            return;
        let watcher = ModuleProxy_1.watchers[this.root] = chokidar_1.watch(this.root, {
            awaitWriteFinish: true,
            followSymlinks: false
        });
        let pathToName = (filename) => {
            return filename.slice(this.root.length + 1, -3).replace(/\\|\//g, ".");
        };
        watcher.on("change", filename => {
            let ext = path.extname(filename);
            if (ext === ".js" || ext === ".ts") {
                delete this.singletons[pathToName(filename)];
                delete require.cache[filename];
                require(filename);
            }
        }).on("unlink", filename => {
            delete this.singletons[pathToName(filename)];
            delete require.cache[filename];
        }).on("unlinkDir", dirname => {
            dirname = dirname + path.sep;
            for (let filename in require.cache) {
                if (startsWith(filename, dirname)) {
                    delete this.singletons[pathToName(filename)];
                    delete require.cache[filename];
                }
            }
        });
    }
    stopWatch() {
        let watcher = ModuleProxy_1.watchers[this.root];
        if (watcher) {
            watcher.close();
        }
    }
    __get(prop) {
        if (prop in this) {
            return this[prop];
        }
        else if (prop in this.children) {
            return this.children[prop];
        }
        else if (typeof prop != "symbol") {
            return (this.children[prop] = new ModuleProxy_1((this.name && `${this.name}.`) + String(prop), this.root, this.singletons, this.remoteSingletons, this.serviceInstances));
        }
    }
    __has(prop) {
        return (prop in this) || (prop in this.children);
    }
};
ModuleProxy.watchers = {};
ModuleProxy = ModuleProxy_1 = tslib_1.__decorate([
    js_magic_1.applyMagic
], ModuleProxy);
exports.ModuleProxy = ModuleProxy;
exports.default = ModuleProxy;
//# sourceMappingURL=index.js.map