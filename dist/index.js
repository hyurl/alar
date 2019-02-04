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
        if (ModuleProxy_1.registry[name]) {
            throw new Error(`Module ${name} already exists.`);
        }
        else if (name.indexOf(".") === -1) {
            ModuleProxy_1.registry[name] = path.normalize(root);
        }
    }
    get path() {
        return ModuleProxy_1.name2path(this.name);
    }
    get ctor() {
        return ModuleProxy_1.load(this.name);
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
        if (ModuleProxy_1.watchers[this.name]) {
            return;
        }
        else if (!ModuleProxy_1.registry[this.name]) {
            throw new Error(`Module ${this.name} cannot watch file changes.`);
        }
        let root = ModuleProxy_1.registry[this.name];
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
        let watcher = ModuleProxy_1.watchers[this.name] = chokidar_1.watch(root, {
            awaitWriteFinish: true,
            followSymlinks: false
        });
        watcher.on("change", clearCache)
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
    stopWatch() {
        let watcher = ModuleProxy_1.watchers[this.name];
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
            return (this.children[prop] = new ModuleProxy_1((this.name && `${this.name}.`) + String(prop), ModuleProxy_1.registry[this.name.split(".")[0]], this.singletons, this.remoteSingletons, this.serviceInstances));
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
(function (ModuleProxy) {
    ModuleProxy.registry = {};
    ModuleProxy.watchers = {};
    function name2path(name) {
        let names = name.split("."), root = names.splice(0, 1)[0];
        return path.resolve(ModuleProxy.registry[root], ...names);
    }
    ModuleProxy.name2path = name2path;
    function load(name) {
        let path = name2path(name);
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
    ModuleProxy.load = load;
})(ModuleProxy = exports.ModuleProxy || (exports.ModuleProxy = {}));
exports.ModuleProxy = ModuleProxy;
exports.default = ModuleProxy;
//# sourceMappingURL=index.js.map