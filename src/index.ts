import { resolve, normalize, extname, sep } from "path";
import { applyMagic } from "js-magic";
import { watch, FSWatcher } from "chokidar";
import hash = require("string-hash");
import objHash = require("object-hash");
import startsWith = require("lodash/startsWith");
import { RpcOptions, RpcChannel, RpcServer, RpcClient } from './rpc';
import { getInstance } from './util';

export { RpcOptions, RpcChannel, FSWatcher };

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
        readonly proto: object;
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
        remote(route?: any): T;
    }
}

export interface ModuleLoader {
    /** Extension name of the module file, by default, it's `.js`. */
    extesion: string,
    /** Loads module from the given `path` (`extension` excluded) or cache. */
    load(path: string): any;
    /** Removes module from cache when watcher is running. */
    remove(path: string): void;
}

const isTsNode = process.execArgv.join(" ").includes("ts-node");
const defaultLoader: ModuleLoader = {
    extesion: ".js",
    load: require,
    remove(path) {
        delete require.cache[path + this.extesion];
    }
}

@applyMagic
export class ModuleProxy {
    private root: { name: string, path: string };
    private loader: ModuleLoader = defaultLoader;
    private singletons: { [name: string]: any } = {};
    private remoteSingletons: { [dsn: string]: any } = {};
    private children: { [name: string]: ModuleProxy } = {};

    constructor(
        readonly name: string,
        path: string,
    ) {
        this.root = {
            name: name.split(".")[0],
            path: normalize(path)
        };
    }

    get path(): string {
        return resolve(this.root.path, ...this.name.split(".").slice(1));
    }

    get exports(): any {
        return this.loader.load(this.path);
    }

    get proto(): object {
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

    get ctor(): ModuleConstructor<any> {
        let { exports } = this;

        if (typeof exports.default === "function")
            return exports.default;
        else if (typeof exports === "function")
            return exports;
        else
            return null;
    }

    /** Creates a new instance of the module. */
    create(...args: any[]) {
        if (this.ctor) {
            return new this.ctor(...args);
        } else if (this.proto) {
            return Object.create(this.proto);
        } else {
            throw new TypeError(`${this.name} is not a valid module.`);
        }
    }

    /** Sets/Gets the singleton instance of the module. */
    instance(ins?: any) {
        if (ins) {
            return (this.singletons[this.name] = ins);
        } else if (this.singletons[this.name]) {
            return this.singletons[this.name];
        } else {
            return (this.singletons[this.name] = getInstance(this));
        }
    }

    /**
     * Gets a remote instance connected according to the `route`.
     * 
     * The module proxy will automatically calculate the route and direct the 
     * traffic to the corresponding remote instance.
     */
    remote(route: any = ""): any {
        let keys = Object.keys(this.remoteSingletons);
        let id = keys[hash(objHash(route)) % keys.length];
        return this.remoteSingletons[id];
    }

    /** Serves an RPC service according to the given configuration. */
    serve(config: string | RpcOptions): Promise<RpcChannel> {
        return new RpcServer(<any>config).open();
    }

    /** Connects an RPC service according to the given configuration. */
    connect(config: string | RpcOptions): Promise<RpcChannel> {
        return new RpcClient(<any>config).open();
    }

    /** Resolves the given path to a module name. */
    resolve(path: string): string {
        let rootPath = this.root.path + sep;

        if (startsWith(path, rootPath)) {
            let modPath = path.slice(rootPath.length),
                ext = extname(modPath);

            if (ext === this.loader.extesion || (
                this.loader.extesion === ".js" && isTsNode && [".ts", ".tsx"].includes(ext)
            )) {
                modPath = modPath.slice(0, -this.loader.extesion.length);
            } else if (ext) {
                return;
            }

            return this.root.name + "." + modPath.replace(/\\|\//g, ".");
        } else {
            return;
        }
    }

    /** Watches file change and reload the corresponding module. */
    watch(listener?: (event: "change" | "unlink", filename: string) => void) {
        let { path } = this.root;
        let clearCache = (event: string, filename: string, cb: Function) => {
            let name = this.resolve(filename);

            if (name) {
                delete this.singletons[name];
                this.loader.remove(filename.slice(0, -this.loader.extesion.length));
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
            this.children[prop] = new ModuleProxy(
                (this.name && `${this.name}.`) + String(prop),
                this.root.path
            );
            this.children[prop].singletons = this.singletons;
            this.children[prop].loader = this.loader;
            return this.children[prop];
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}

export default ModuleProxy;