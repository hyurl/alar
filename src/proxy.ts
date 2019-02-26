import hash = require("string-hash");
import objectHash = require("object-hash");
import { sep, normalize } from "path";
import { applyMagic } from "js-magic";
import { getInstance, local, remotized, noLocal } from './util';
import { ModuleLoader } from './index';

const isTsNode = process.execArgv.join(" ").includes("ts-node");
const defaultLoader: ModuleLoader = {
    extesion: isTsNode ? ".ts" : ".js",
    load: require,
    unload(filename) {
        delete require.cache[filename];
    }
}

@applyMagic
export class ModuleProxyConstructor<T = any> implements ModuleProxy<T> {
    readonly path: string;
    protected loader: ModuleLoader = defaultLoader;
    protected singletons: { [name: string]: T } = {};
    protected remoteSingletons: { [dsn: string]: T } = {};
    protected children: { [name: string]: ModuleProxy<any> } = {};

    constructor(readonly name: string, path: string) {
        this.path = normalize(path);
    }

    get exports(): any {
        return this.loader.load(this.path + this.loader.extesion);
    }

    get proto(): T {
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

    get ctor(): ModuleConstructor<T> {
        let { exports } = this;

        if (typeof exports.default === "function")
            return exports.default;
        else if (typeof exports === "function")
            return exports;
        else
            return null;
    }

    create(...args: any[]): T {
        if (this.ctor) {
            return new this.ctor(...args);
        } else if (this.proto) {
            return Object.create(<any>this.proto);
        } else {
            throw new TypeError(`${this.name} is not a valid module.`);
        }
    }

    instance(route: any = ""): T {
        let keys = Object.keys(this.remoteSingletons);

        if (route === local || !this[remotized] || (!keys.length && !this[noLocal])) {
            return this.singletons[this.name] || (
                this.singletons[this.name] = getInstance(<any>this)
            );
        } else if (keys.length) {
            // If the module is connected to one or more remote instances,
            // redirect traffic to them automatically.
            let id = keys[hash(objectHash(route)) % keys.length];
            return this.remoteSingletons[id];
        } else {
            throw new ReferenceError("RPC service is not available.");
        }
    }

    noLocal(): this {
        this[noLocal] = true;
        return this;
    }

    remote(route: any = ""): T {
        process.emitWarning("ModuleProxy<T>.route() has been deprecated, use ModuleProxy<T>.instance() instead");
        return this.instance(route);
    }

    protected __get(prop: string) {
        if (prop in this) {
            return this[prop];
        } else if (prop in this.children) {
            return this.children[prop];
        } else if (typeof prop != "symbol") {
            let child = new ModuleProxyConstructor(
                this.name + "." + String(prop),
                this.path + sep + String(prop)
            );

            child.singletons = this.singletons;
            child.loader = this.loader;

            return this.children[prop] = child;
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}