import { extname, sep, normalize } from "path";
import { applyMagic } from "js-magic";
import { watch, FSWatcher } from "chokidar";
import hash = require("string-hash");
import objHash = require("object-hash");
import startsWith = require("lodash/startsWith");
import { RpcOptions, RpcChannel, RpcServer, RpcClient } from './rpc';
import { getInstance, createRemoteInstance, mergeFnProperties } from './util';

export { RpcOptions, RpcChannel, FSWatcher };

// Auto-Load And Remote.

type FunctionPropertyNames<T> = { [K in keyof T]: T[K] extends Function ? K : never }[keyof T];
type FunctionProperties<T> = Pick<T, FunctionPropertyNames<T>>;

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

        /** Sets/Gets the singleton instance of the module. */
        instance(ins?: T): T;

        /**
         * Gets a remote instance connected according to the `route`.
         * 
         * The module proxy will automatically calculate the route and direct 
         * the traffic to the corresponding remote instance.
         */
        remote(route?: any): FunctionProperties<T>;
    }
}

export interface ModuleLoader {
    [x: string]: any;
    /**
     * Extension name of the module file, by default, it's `.js` (or `.ts` in 
     * ts-node).
     */
    extesion: string,
    /** Loads module from the given file or cache. */
    load(filename: string): any;
    /** Unloads the module in cache if the file is modified. */
    unload(filename: string): void;
}

const isTsNode = process.execArgv.join(" ").includes("ts-node");
const defaultLoader: ModuleLoader = {
    extesion: isTsNode ? ".ts" : ".js",
    load: require,
    unload(filename) {
        delete require.cache[filename];
    }
}

@applyMagic
export class ModuleProxy<T = any> {
    readonly path: string;
    private loader: ModuleLoader = defaultLoader;
    private singletons: { [name: string]: T } = {};
    private remoteSingletons: { [dsn: string]: FunctionProperties<T> } = {};
    private children: { [name: string]: ModuleProxy } = {};
    private remoteHolder?: FunctionProperties<T> = null;

    constructor(readonly name: string, path: string) {
        this.path = normalize(path);
    }

    protected get exports(): any {
        return this.loader.load(this.path + this.loader.extesion);
    }

    protected get proto(): T {
        let { exports } = this;

        if (typeof exports.default === "object")
            return exports.default;
        else if (typeof exports.default === "function")
            return exports.default.prototype;
        else if (typeof exports === "object")
            return exports;
        else if (typeof exports === "function")
            return exports.prototype;
        else
            return null;
    }

    protected get ctor(): ModuleConstructor<T> {
        let { exports } = this;

        if (typeof exports.default === "function")
            return exports.default;
        else if (typeof exports === "function")
            return exports;
        else
            return null;
    }

    /** Creates a new instance of the module. */
    protected create(...args: any[]): T {
        if (this.ctor) {
            return new this.ctor(...args);
        } else if (this.proto) {
            return Object.create(<any>this.proto);
        } else {
            throw new TypeError(`${this.name} is not a valid module.`);
        }
    }

    /** Sets/Gets the singleton instance of the module. */
    protected instance(ins?: T): T {
        if (ins) {
            return (this.singletons[this.name] = ins);
        } else if (this.singletons[this.name]) {
            return this.singletons[this.name];
        } else {
            return (this.singletons[this.name] = getInstance(<any>this));
        }
    }

    /**
     * Gets a remote instance connected according to the `route`.
     * 
     * The module proxy will automatically calculate the route and direct the 
     * traffic to the corresponding remote instance.
     */
    protected remote(route: any = ""): FunctionProperties<T> {
        let keys = Object.keys(this.remoteSingletons);

        if (keys.length) {
            // Redirect traffic automatically.
            let id = keys[hash(objHash(route)) % keys.length];
            return this.remoteSingletons[id];
        } else if (this.remoteHolder) {
            return this.remoteHolder;
        } else {
            return this.remoteHolder = createRemoteInstance(
                <any>this,
                (ins, prop) => {
                    return mergeFnProperties(function () {
                        return Promise.reject(
                            new ReferenceError("RPC service is not available.")
                        );
                    }, ins[prop]);
                }
            );
        }
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

            if (ext === this.loader.extesion) {
                modPath = modPath.slice(0, -this.loader.extesion.length);
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

    protected __get(prop: string) {
        if (prop in this) {
            return this[prop];
        } else if (prop in this.children) {
            return this.children[prop];
        } else if (typeof prop != "symbol") {
            let child = this.children[prop] = new ModuleProxy(
                this.name + "." + String(prop),
                this.path + sep + String(prop)
            );

            child.singletons = this.singletons;
            child.loader = this.loader;
            return child;
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}

export default ModuleProxy;