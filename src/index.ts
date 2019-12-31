import { extname, sep } from "path";
import { watch, FSWatcher } from "chokidar";
import startsWith = require("lodash/startsWith");
import { RpcOptions, RpcChannel } from './rpc/channel';
import { RpcClient, ClientOptions } from "./rpc/client";
import { RpcServer } from "./rpc/server";
import { ModuleProxy as ModuleProxyBase } from "./proxy";
import { local, RpcState, tryLifeCycleFunction, set, patchProperties } from './util';
import { ModuleLoader } from "./header";

export {
    ModuleLoader,
    RpcOptions,
    RpcChannel,
    RpcServer,
    RpcClient,
    ClientOptions,
    FSWatcher,
    local
};

const cmd = process.execArgv.concat(process.argv).join(" ");
const isTsNode = cmd.includes("ts-node");
const defaultLoader: ModuleLoader = {
    extension: isTsNode ? ".ts" : ".js",
    cache: require.cache,
    load: require,
    unload(filename) {
        delete this.cache[filename];
    }
}

export class ModuleProxy extends ModuleProxyBase {
    /**
     * If passed to the `ModuleProxy<T>.instance()`, the method will always 
     * return the local instance.
     */
    readonly local: symbol;

    constructor(readonly name: string, path: string, loader?: ModuleLoader) {
        super();
        patchProperties(this, path, defaultLoader, {});
        this.local = local;
        loader && this.setLoader(loader);
    }

    get exports() {
        return {};
    }

    /** Serves an RPC service according to the given configuration. */
    serve(config: string | RpcOptions): Promise<RpcServer> {
        return new RpcServer(<any>config).open();
    }

    /** Connects an RPC service according to the given configuration. */
    connect(config: string | ClientOptions): Promise<RpcClient> {
        return new RpcClient(<any>config).open();
    }

    /** Resolves the given path to a module name. */
    resolve(path: string): string {
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

            if (name) {
                if (this.singletons[name]) {
                    let unloaded = false;
                    let tryUnload = () => {
                        if (!unloaded) {
                            delete this.singletons[name];
                            this.loader.unload(filename);
                            unloaded = true;
                        }
                    };

                    try {
                        if (this[RpcState]) {
                            this[RpcState] = 2;
                            await tryLifeCycleFunction(this, "destroy");
                        }

                        tryUnload();

                        if (this[RpcState]) {
                            await tryLifeCycleFunction(this, "init");
                            this[RpcState] = 1;
                        }
                    } catch (err) {
                        console.error(err);
                        tryUnload();
                    }
                } else {
                    this.loader.unload(filename);
                }

                cb && cb(event, filename);
            }
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