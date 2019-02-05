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

@applyMagic
export class ModuleProxy {
    private root: { name: string, path: string };
    private remoteSingletons: { [dsn: string]: any } = {};
    private children: { [name: string]: ModuleProxy } = {};

    constructor(
        readonly name: string,
        path: string,
        private singletons: { [name: string]: any } = {},
    ) {
        this.root = {
            name: name.split(".")[0],
            path: normalize(path)
        };
    }

    get path(): string {
        return resolve(this.root.path, ...this.name.split(".").slice(1));
    }

    get ctor(): ModuleConstructor<any> {
        let { path } = this;
        let mod = require.cache[path + ".ts"] || require.cache[path + ".js"];

        if (!mod) {
            mod = require(path);

            if (!mod.default || typeof mod.default !== "function") {
                throw new TypeError(`Module ${this.name} is not a constructor.`);
            }
        } else {
            mod = mod.exports;
        }

        return mod.default;
    }

    /** Creates a new instance of the module. */
    create(...args: any[]) {
        return new this.ctor(...args);
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

    /** Watches file change and reload the corresponding module. */
    watch() {
        let { name, path } = this.root;
        let pathToName = (filename: string) => {
            let modPath = filename.slice(path.length + 1, -3);
            return name + "." + modPath.replace(/\\|\//g, ".");
        };
        let clearCache = (filename: string) => {
            let ext = extname(filename);
            let name = pathToName(filename);

            if ((ext === ".js" || ext === ".ts") && require.cache[filename]) {
                delete this.singletons[name];
                delete require.cache[filename];
            }
        };

        return watch(path, {
            persistent: false,
            awaitWriteFinish: true,
            followSymlinks: false
        }).on("change", clearCache)
            .on("unlink", clearCache)
            .on("unlinkDir", dirname => {
                dirname = dirname + sep;

                for (let filename in require.cache) {
                    if (startsWith(filename, dirname)) {
                        delete this.singletons[pathToName(filename)];
                        delete require.cache[filename];
                    }
                }
            });
    }

    protected __get(prop: string) {
        if (prop in this) {
            return this[prop];
        } else if (prop in this.children) {
            return this.children[prop];
        } else if (typeof prop != "symbol") {
            return (this.children[prop] = new ModuleProxy(
                (this.name && `${this.name}.`) + String(prop),
                this.root.path,
                this.singletons,
            ));
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}

export default ModuleProxy;