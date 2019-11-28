import { extname, sep } from "path";
import { watch, FSWatcher } from "chokidar";
import startsWith = require("lodash/startsWith");
import { RpcOptions, RpcChannel } from './rpc/channel';
import { RpcClient, ClientOptions } from "./rpc/client";
import { RpcServer } from "./rpc/server";
import { ModuleProxyBase } from "./proxy";
import { local, RpcState, tryLifeCycleFunction, set } from './util';

export {
    ModuleProxyBase,
    RpcOptions,
    RpcChannel,
    RpcServer,
    RpcClient,
    ClientOptions,
    FSWatcher,
    local
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
    type AsynchronizedFunctionProperties<T> = {
        [K in keyof FunctionProperties<T>]: ReturnType<T[K]> extends Promise<any>
        ? T[K]
        : (ReturnType<T[K]> extends (AsyncIterableIterator<infer U> | IterableIterator<infer U>)
            ? (...args: Parameters<T[K]>) => AsyncIterableIterator<U> & Promise<U>
            : (...args: Parameters<T[K]>) => Promise<ReturnType<T[K]>>
        );
    }
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
        readonly loader: ModuleLoader;
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
        instance(local: symbol): AsynchronizedFunctionProperties<T> & Readonly<NonFunctionProperties<T>>;
        instance(route?: any): AsynchronizedFunctionProperties<T> & Voidable<Readonly<NonFunctionProperties<T>>>;

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
    /**
     * It is recommended using this property to store loaded modules, so that
     * the internal watcher can manipulate the cache when necessary.
     */
    cache?: { [filename: string]: any };
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

            if (name && this.singletons[name]) {
                try {
                    if (this[RpcState]) {
                        this[RpcState] = 2;
                        await tryLifeCycleFunction(this, "destroy");
                    }

                    delete this.singletons[name];
                    this.loader.unload(filename);

                    if (this[RpcState]) {
                        await tryLifeCycleFunction(this, "init");
                        this[RpcState] = 1;
                    }
                } catch (err) {
                    console.error(err);
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