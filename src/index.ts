import { extname, sep } from "path";
import { watch, FSWatcher } from "chokidar";
import startsWith = require("lodash/startsWith");
import { RpcOptions, RpcChannel, RpcServer, RpcClient } from './rpc';
import { ModuleProxyBase } from "./proxy";
import { local } from './util';

export { RpcOptions, RpcChannel, RpcServer, RpcClient, FSWatcher };

// Auto-Load And Remote.

declare global {
    interface ModuleConstructor<T> {
        new(...args: any[]): T;
        getInstance?(): T;
    }

    interface ModuleProxy<T, R1 = any, R2 = any, R3 = any, R4 = any, R5 = any> {
        /** The name (with namespace) of the module. */
        readonly name: string;
        /** The path (without extension) of the module. */
        readonly path: string;
        /** The very exports object of the module. */
        readonly exports: any;
        /** The very prototype of the module. */
        readonly proto: T;
        /** The very class constructor of the module. */
        readonly ctor: ModuleConstructor<T>;

        /** Creates a new instance of the module. */
        create(): T;
        create(arg1: R1): T;
        create(arg1: R1, arg2: R2): T;
        create(arg1: R1, arg2: R2, arg3: R3): T;
        create(arg1: R1, arg2: R2, arg3: R3, arg4: R4): T;
        create(arg1: R1, arg2: R2, arg3: R3, arg4: R4, arg5: R5): T;
        create(...args: any[]): T;

        /**
         * Gets the local singleton or a remote instance of the module, if 
         * connected to one or more remote instances, the module proxy will 
         * automatically calculate the `route` and direct the traffic to the 
         * corresponding remote instance.
         */
        instance(route?: any): T;

        /**
         * @deprecated use `instance()` instead.
         */
        remote(route?: any): T;

        /**
         * If the module is registered as remote service, however when no RPC 
         * channel is available, by default, `instance()` will fail to the local
         * instance, using this method to disable the default behavior.
         */
        noLocal(): this;
    }
}

export interface ModuleLoader {
    [x: string]: any;
    /**
     * Extension name of the module file, by default, it's `.js` (or `.ts` in 
     * ts-node).
     */
    extension: string,
    /** Loads module from the given file or cache. */
    load(filename: string): any;
    /** Unloads the module in cache if the file is modified. */
    unload(filename: string): void;
}

export class ModuleProxy extends ModuleProxyBase {
    /**
     * If passed to the `ModuleProxy<T>.instance()`, the method will always 
     * return the local instance.
     */
    local = local;

    get exports() {
        return {};
    }

    /** Serves an RPC service according to the given configuration. */
    serve(config: string | RpcOptions): Promise<RpcServer> {
        return new RpcServer(<any>config).open();
    }

    /** Connects an RPC service according to the given configuration. */
    connect(config: string | RpcOptions): Promise<RpcClient> {
        return new RpcClient(<any>config).open();
    }

    /** Resolves the given path to a module name. */
    resolve(path: string): string {
        let dir = this.path + sep;

        if (startsWith(path, dir)) {
            let modPath = path.slice(dir.length),
                ext = extname(modPath);

            if (ext === this.loader.extension) {
                modPath = modPath.slice(0, -this.loader.extension.length);
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
        let clearCache = (event: string, filename: string, cb: Function) => {
            let name = this.resolve(filename);

            if (name) {
                delete this.singletons[name];
                this.loader.unload(filename);
                cb && cb(event, filename);
            }
        };

        return watch(path, {
            awaitWriteFinish: true,
            followSymlinks: false
        }).on("change", (filename) => {
            clearCache("change", filename, listener);
        }).on("unlink", (filename) => {
            clearCache("unlink", filename, listener);
        }).on("unlinkDir", dirname => {
            dirname = dirname + sep;

            for (let filename in require.cache) {
                if (startsWith(filename, dirname)) {
                    clearCache("unlink", filename, listener);
                }
            }
        });
    }

    /** Sets a custom loader to resolve the module. */
    setLoader(loader: ModuleLoader) {
        this.loader = loader;
    }
}

export default ModuleProxy;