import { extname, sep } from "path";
import { watch, FSWatcher } from "chokidar";
import startsWith = require("lodash/startsWith");
import { RpcOptions, RpcChannel } from './rpc/channel';
import { RpcClient, ClientOptions } from "./rpc/client";
import { RpcServer } from "./rpc/server";
import { ModuleProxyBase } from "./proxy";
import * as util from './util';

export {
    ModuleProxyBase,
    RpcOptions,
    RpcChannel,
    RpcServer,
    RpcClient,
    ClientOptions,
    FSWatcher,
    util
};

// Auto-Load And Remote.

declare global {
    type FunctionPropertyNames<T> = {
        [K in keyof T]: T[K] extends Function ? K : never
    }[keyof T];
    type NonFunctionPropertyNames<T> = {
        [K in keyof T]: T[K] extends Function ? never : K
    }[keyof T];
    type FunctionProperties<T> = Pick<T, FunctionPropertyNames<T>>;
    type NonFunctionProperties<T> = Pick<T, NonFunctionPropertyNames<T>>;
    type Voidable<T> = {
        [K in keyof T]: T[K] | void
    }

    interface ModuleConstructor<T> {
        new(...args: any[]): T;
        getInstance?(): T;
    }

    interface ModuleProxy<T, A1 = any, A2 = any, A3 = any, A4 = any, A5 = any> {
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
        create(arg1: A1): T;
        create(arg1: A1, arg2: A2): T;
        create(arg1: A1, arg2: A2, arg3: A3): T;
        create(arg1: A1, arg2: A2, arg3: A3, arg4: A4): T;
        create(arg1: A1, arg2: A2, arg3: A3, arg4: A4, arg5: A5): T;

        /**
         * Gets the local singleton or a remote instance of the module, if 
         * connected to one or more remote instances, the module proxy will 
         * automatically calculate the `route` and direct the traffic to the 
         * corresponding remote instance.
         */
        instance(local: symbol): T;
        instance(route?: any): FunctionProperties<T> &
            Voidable<Readonly<NonFunctionProperties<T>>>;

        /**
         * If the module is registered as remote service, however when no RPC 
         * channel is available, by default, `instance()` will fail to the local
         * instance, using this method to disable the default behavior.
         */
        noLocal(): this;

        /**
         * Allowing the current module to be injected as a dependency bound to a
         * property of another class instance.
         */
        inject(route?: any): PropertyDecorator;
    }
}

export interface ModuleLoader {
    [x: string]: any;
    /**
     * Extension name of the module file, by default, it's `.js` (or `.ts` in 
     * ts-node).
     */
    extension: string | string[],
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
    local = util.local;

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
            followSymlinks: false,
            ignored: /\.(js\.map|d\.ts|md)$/
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