"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const chokidar_1 = require("chokidar");
exports.FSWatcher = chokidar_1.FSWatcher;
const startsWith = require("lodash/startsWith");
const rpc_1 = require("./rpc");
exports.RpcChannel = rpc_1.RpcChannel;
exports.RpcServer = rpc_1.RpcServer;
exports.RpcClient = rpc_1.RpcClient;
const proxy_1 = require("./proxy");
const util_1 = require("./util");
class ModuleProxy extends proxy_1.ModuleProxyBase {
    constructor() {
        super(...arguments);
        this.local = util_1.local;
    }
    get exports() {
        return {};
    }
    serve(config) {
        return new rpc_1.RpcServer(config).open();
    }
    connect(config) {
        return new rpc_1.RpcClient(config).open();
    }
    resolve(path) {
        let dir = this.path + path_1.sep;
        if (startsWith(path, dir)) {
            let modPath = path.slice(dir.length), ext = path_1.extname(modPath);
            if (ext === this.loader.extesion) {
                modPath = modPath.slice(0, -this.loader.extesion.length);
            }
            else if (ext) {
                return;
            }
            return this.name + "." + modPath.replace(/\\|\//g, ".");
        }
        else {
            return;
        }
    }
    watch(listener) {
        let { path } = this;
        let clearCache = (event, filename, cb) => {
            let name = this.resolve(filename);
            if (name) {
                delete this.singletons[name];
                this.loader.unload(filename);
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
}
exports.ModuleProxy = ModuleProxy;
exports.default = ModuleProxy;
//# sourceMappingURL=index.js.map