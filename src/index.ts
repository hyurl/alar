import * as path from "path";
import { applyMagic } from "js-magic";
import { watch, FSWatcher } from "chokidar";
import { createInstance, ServiceOptions, ServiceInstance } from "asrpc";
import hash = require("string-hash");
import objHash = require("object-hash");
import startsWith = require("lodash/startsWith");

// Simple Entry Proxy And Remote.

declare global {
    interface ModuleProxy<T, R1 = any, R2 = any, R3 = any, R4 = any, R5 = any> {
        readonly name: string;
        readonly path: string;
        readonly ctor: new (...args: any[]) => T;

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
         * Uses a remote instance of the module.
         * Must call `connect()` to establish connection of the remote instance
         * before using this method.
         * 
         * The `route` can be any value, the module proxy will automatically
         * calculate it and direct the traffic to one of the remote instances 
         * connected according to the route.
         */
        remote(route?: any): T;

        /** Starts a remote instance of the module. */
        serve(server: ServiceOptions): Promise<void>;

        /** Connects to a remote instance of the module. */
        connect(server: ServiceOptions): Promise<void>;
    }
}

@applyMagic
export class ModuleProxy {
    readonly root: string;
    private children: { [name: string]: ModuleProxy } = {};

    static watchers: { [dirname: string]: FSWatcher } = {};

    constructor(
        readonly name: string,
        root: string,
        private singletons: { [name: string]: any } = {},
        private remoteSingletons: { [name: string]: any } = {},
        private serviceInstances: { [id: string]: ServiceInstance } = {}
    ) {
        this.root = path.normalize(root);
    }

    get path(): string {
        return path.resolve(this.root, ...this.name.split(".").slice(1));
    }

    get ctor(): new (...args: any[]) => any {
        let { path } = this;
        let mod = require.cache[path + ".ts"] || require.cache[path + ".js"];

        if (!mod) {
            mod = require(path);

            if (!mod.default || typeof mod.default !== "function") {
                throw new TypeError(`Module ${this.name} is not a constructor`);
            }
        } else {
            mod = mod.exports;
        }

        return mod.default;
    }

    instance(ins?: any) {
        if (ins) {
            return (this.singletons[this.name] = ins);
        } else if (this.singletons[this.name]) {
            return this.singletons[this.name];
        } else if (typeof this.ctor["getInstance"] === "function") {
            return (this.singletons[this.name] = this.ctor["getInstance"]());
        } else {
            try {
                return new this.ctor();
            } catch (err) {
                return Object.create(this.ctor.prototype);
            }
        }
    }

    create(...args: any[]) {
        return new this.ctor(...args);
    }

    async serve(server: ServiceOptions): Promise<void> {
        let id = objHash(server),
            ins = this.serviceInstances[id];

        if (!ins) {
            ins = this.serviceInstances[id] = createInstance(server);
            await ins.start();
        }

        ins.register(this.ctor);
    }

    async connect(server: ServiceOptions): Promise<void> {
        let id = objHash(server),
            ins = this.serviceInstances[id];

        if (!ins) {
            ins = this.serviceInstances[id] = createInstance(server);
        }

        await ins.connect(this.ctor);
        this.remoteSingletons[this.name].push(ins);
    }

    remote(route: any = ""): any {
        let id = hash(objHash(route)) % this.remoteSingletons[this.name].length;
        return this.remoteSingletons[this.name][id];
    }

    /** Watches file changes and reload the corresponding module. */
    watch() {
        if (ModuleProxy.watchers[this.root]) return;

        let watcher = ModuleProxy.watchers[this.root] = watch(this.root, {
            awaitWriteFinish: true,
            followSymlinks: false
        });
        let pathToName = (filename: string) => {
            return filename.slice(this.root.length + 1, -3).replace(/\\|\//g, ".");
        }

        watcher.on("change", filename => {
            let ext = path.extname(filename);
            if (ext === ".js" || ext === ".ts") {
                delete this.singletons[pathToName(filename)];
                delete require.cache[filename];
                require(filename);
            }
        }).on("unlink", filename => {
            delete this.singletons[pathToName(filename)];
            delete require.cache[filename];
        }).on("unlinkDir", dirname => {
            dirname = dirname + path.sep;

            for (let filename in require.cache) {
                if (startsWith(filename, dirname)) {
                    delete this.singletons[pathToName(filename)];
                    delete require.cache[filename];
                }
            }
        });
    }

    stopWatch() {
        let watcher = ModuleProxy.watchers[this.root];

        if (watcher) {
            watcher.close();
        }
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
                this.remoteSingletons,
                this.serviceInstances
            ));
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}

export default ModuleProxy;