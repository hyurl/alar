import * as path from "path";
import { applyMagic } from "js-magic";
import { watch, FSWatcher } from "chokidar";
import hash = require("string-hash");
import objHash = require("object-hash");
import startsWith = require("lodash/startsWith");
import values = require("lodash/values");
import { RemoteService, createRemoteInstance, RemoteOptions } from './rpc';

// Simple Entry Proxy And Remote.

declare global {
    interface ModuleConstructor<T> {
        new(...args: any[]): T;
        getInstance?(...args: any[]): T;
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
    private root: string;
    private children: { [name: string]: ModuleProxy } = {};
    private remoteSingletons: any[] = [];

    constructor(
        readonly name: string,
        root: string,
        private singletons: { [name: string]: any } = {},
        private remoteServices: RemoteService[] = []
    ) {
        this.root = path.normalize(root);
        ModuleProxy.registry[name] = this;
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
                throw new TypeError(`Module ${this.name} is not a constructor.`);
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
                ins = this.create();
            } catch (err) {
                ins = Object.create(this.ctor.prototype);
            }
            return (this.singletons[this.name] = ins);
        }
    }

    create(...args: any[]) {
        return new this.ctor(...args);
    }

    async serve(server: RemoteOptions): Promise<void> {
        let service = new RemoteService(server);
        this.remoteServices.push(service);
        await service.serve();
    }

    async connect(server: RemoteOptions): Promise<void> {
        let service = new RemoteService(server);
        this.remoteServices.push(service);
        await service.connect();
    }

    remote(route: any = ""): any {
        let id = hash(objHash(route)) % this.remoteServices.length;

        if (!this.remoteSingletons[id]) {
            this.remoteSingletons[id] = createRemoteInstance(
                <any>this,
                this.remoteServices[id]
            );
        }

        return this.remoteSingletons[id]
    }

    /** Watches file changes and reload the corresponding module. */
    watch() {
        if (ModuleProxy.watchers[this.name]) {
            return;
        }

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
        let watcher = ModuleProxy.watchers[this.name] = watch(root, {
            awaitWriteFinish: true,
            followSymlinks: false
        });

        watcher.on("change", clearCache)
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

    stopWatch() {
        let watcher = ModuleProxy.watchers[this.name];

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
                this.remoteServices
            ));
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}

export namespace ModuleProxy {
    export const registry: { [name: string]: ModuleProxy } = {};
    export const watchers: { [name: string]: FSWatcher } = {};
}

export default ModuleProxy;