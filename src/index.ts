import * as path from "path";
import { applyMagic } from "js-magic";
import { watch } from "chokidar";
import hash = require("string-hash");
import objHash = require("object-hash");
import startsWith = require("lodash/startsWith");
import { RpcOptions, RpcChannel, RpcServer, RpcClient } from './rpc';

export { RpcOptions, RpcChannel };

// Simple Entry Proxy And Remote.

declare global {
    interface ModuleConstructor<T> {
        new(...args: any[]): T;
        getInstance?(): T;
    }

    interface ModuleProxy<T, R1 = any, R2 = any, R3 = any, R4 = any, R5 = any> {
        readonly name: string;
        readonly path: string;
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
    private root: string;
    private remoteSingletons: any[] = [];
    private children: { [name: string]: ModuleProxy } = {};

    constructor(
        readonly name: string,
        root: string,
        private singletons: { [name: string]: any } = {},
    ) {
        this.root = path.normalize(root);
    }

    get path(): string {
        return path.resolve(this.root, ...this.name.split(".").slice(1));
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
        } else if (typeof this.ctor.getInstance === "function") {
            return (this.singletons[this.name] = this.ctor.getInstance());
        } else {
            try {
                ins = this.create();
            } catch (err) {
                ins = Object.create(this.ctor.prototype);
            }
            return (this.singletons[this.name] = ins);
        }
    }

    /**
     * Gets a remote instance connected according to the `route`.
     * 
     * The module proxy will automatically calculate the route and direct the 
     * traffic to the corresponding remote instance.
     */
    remote(route: any = ""): any {
        let id = hash(objHash(route)) % this.remoteSingletons.length;
        return this.remoteSingletons[id];
    }

    /** Serves a RPC service according to the given configuration. */
    serve(config: string | RpcOptions): Promise<RpcChannel> {
        return new RpcServer(<any>config).open();
    }

    /** Serves a RPC service according to the given configuration. */
    connect(config: string | RpcOptions): Promise<RpcChannel> {
        return new RpcClient(<any>config).open();
    }

    /** Watches file changes and reload the corresponding module. */
    watch() {
        let { root } = this;
        let pathToName = (filename: string) => {
            return filename.slice(root.length + 1, -3).replace(/\\|\//g, ".");
        };
        let clearCache = (filename: string) => {
            let ext = path.extname(filename);
            if (ext === ".js" || ext === ".ts") {
                delete this.singletons[pathToName(filename)];
                delete require.cache[filename];
            }
        };

        return watch(root, {
            awaitWriteFinish: true,
            followSymlinks: false
        }).on("change", clearCache)
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

    protected __get(prop: string) {
        if (prop in this) {
            return this[prop];
        } else if (prop in this.children) {
            return this.children[prop];
        } else if (typeof prop != "symbol") {
            return (this.children[prop] = new ModuleProxy(
                (this.name && `${this.name}.`) + String(prop),
                this.root,
                this.singletons,
            ));
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}

export default ModuleProxy;