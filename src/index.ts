import { extname, resolve, sep } from "path";
import { watch, FSWatcher } from "chokidar";
import startsWith = require("lodash/startsWith");
import once = require("lodash/once");
import { RpcOptions, RpcChannel } from './rpc/channel';
import { RpcClient, ClientOptions } from "./rpc/client";
import { RpcServer } from "./rpc/server";
import { ModuleLoader } from "./header";
import {
    ModuleProxy as ModuleProxyBase,
    createModuleProxy,
    defaultLoader
} from "./proxy";
import {
    local,
    set,
    dict,
    patchProperties,
    tryLifeCycleFunction,
} from './util';

export {
    local,
    ModuleLoader,
    RpcOptions,
    RpcChannel,
    RpcServer,
    RpcClient,
    ClientOptions,
    FSWatcher,
    createModuleProxy
};

export class ModuleProxy extends ModuleProxyBase {
    /**
     * If passed to the `ModuleProxy<T>.instance()`, the method will always 
     * return the local instance.
     */
    readonly local: symbol;
    private server: RpcServer = null;

    constructor(readonly name: string, path: string, loader?: ModuleLoader) {
        super();
        patchProperties(this, path, loader || defaultLoader, dict());
        this.local = local;
    }

    /** Serves an RPC service according to the given configuration. */
    async serve(config: string | RpcOptions, immediate = true) {
        this.server = new RpcServer(<any>config);
        this.server["proxyRoot"] = this;
        immediate && (await this.server.open(false));
        return this.server;
    }

    /** Connects an RPC service according to the given configuration. */
    async connect(config: string | ClientOptions, immediate = true) {
        let client = new RpcClient(<any>config);
        immediate && (await client.open());
        return client;
    }

    /** Resolves the given path to a module name. */
    resolve(path: string): string {
        path = resolve(path);
        let dir = this.path + sep;

        if (startsWith(path, dir)) {
            let modPath = path.slice(dir.length),
                ext = extname(modPath);

            if (Array.isArray(this.loader.extension)) {
                if (this.loader.extension.includes(ext)) {
                    modPath = modPath.slice(0, -ext.length);
                } else {
                    return;
                }
            } else if (ext === this.loader.extension) {
                modPath = modPath.slice(0, -ext.length);
            } else if (ext) {
                return;
            }

            return this.name + "." + modPath.replace(/\\|\//g, ".");
        } else {
            return;
        }
    }

    /** Watches file change and reload the corresponding module. */
    watch(listener?: (event: "change" | "unlink", filename: string) => void) {
        let { path } = this;
        let clearCache = async (
            event: "change" | "unlink",
            filename: string,
            cb: Parameters<ModuleProxy["watch"]>[0]
        ) => {
            let name = this.resolve(filename);

            if (name && this.singletons[name]) {
                let tryUnload = once(() => {
                    delete this.singletons[name];
                    this.loader.unload(filename);
                });

                try {
                    if (this.server &&
                        this.server["enableLifeCycle"] &&
                        this.server["registry"][name]
                    ) {
                        let mod = this.server["registry"][name];
                        let handleError = this.server["errorHandler"];
                        await tryLifeCycleFunction(mod, "destroy", handleError);
                        tryUnload();
                        await tryLifeCycleFunction(mod, "init", handleError);
                    } else {
                        tryUnload();
                    }
                } catch (err) {
                    console.error(err);
                    tryUnload();
                }
            } else {
                this.loader.unload(filename);
            }

            cb && cb(event, filename);
        };

        return watch(path, {
            awaitWriteFinish: true,
            followSymlinks: false,
            ignored: (file: string) => {
                let ext = extname(file);

                if (!ext) {
                    return false;
                } else if (typeof this.loader.extension === "string") {
                    return this.loader.extension !== ext;
                } else {
                    return !this.loader.extension.includes(ext);
                }
            }
        }).on("change", (filename) => {
            clearCache("change", filename, listener);
        }).on("unlink", (filename) => {
            clearCache("unlink", filename, listener);
        }).on("unlinkDir", dirname => {
            dirname = dirname + sep;

            if (this.loader.cache) {
                for (let filename in this.loader.cache) {
                    if (startsWith(filename, dirname)) {
                        clearCache("unlink", filename, listener);
                    }
                }
            }
        });
    }

    /** Sets a custom loader to resolve the module. */
    setLoader(loader: ModuleLoader) {
        set(this, "loader", loader);
    }
}

export default ModuleProxy;
