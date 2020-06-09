import { sep, dirname, basename, extname } from "path";
import { applyMagic } from "js-magic";
import { ModuleLoader } from './index';
import { Injectable } from "./di";
import { readdirSync } from 'fs';
import cloneDeep = require("lodash/cloneDeep");
import merge = require("lodash/merge");
import values = require("lodash/values");
import typeOf from "@hyurl/utils/typeOf";
import {
    local,
    set,
    dict,
    patchProperties,
    getInstance,
    throwUnavailableError,
    readyState,
    proxyRoot,
    evalRouteId
} from './util';
import { ModuleProxy as ModuleProxyRoot } from ".";

const fallbackToLocal = Symbol("fallbackToLocal");
const cmd = process.execArgv.concat(process.argv).join(" ");
const isTsNode = cmd.includes("ts-node");
export const defaultLoader: ModuleLoader = {
    extension: isTsNode ? ".ts" : ".js",
    cache: require.cache,
    load: require,
    unload(filename) {
        delete this.cache[filename];
    }
}

/**
 * Creates a module proxy manually.
 */
export function createModuleProxy(
    name: string,
    path: string,
    loader = defaultLoader,
    singletons = dict(),
    root: ModuleProxyRoot = void 0
): ModuleProxy {
    let proxy: ModuleProxy = <any>function (...args: any[]) {
        if (!new.target) {
            return proxy.instance(args[0]);
        } else {
            return proxy.create(...args);
        }
    };

    (!loader && root) && (loader = root["loader"]);
    (!singletons && root) && (singletons = root["singletons"]);
    Object.setPrototypeOf(proxy, ModuleProxy.prototype);
    set(proxy, "name", name);
    patchProperties(proxy, path, loader, singletons);
    proxy[fallbackToLocal] = true;
    proxy[proxyRoot] = root;
    proxy[Symbol.toStringTag] = "ModuleProxy";
    proxy[Symbol.hasInstance] = function ModuleProxy(ins: any) {
        return ins instanceof proxy.ctor;
    };

    return applyMagic(<any>proxy, true);
}


@applyMagic
export abstract class ModuleProxy extends Injectable {
    abstract readonly name: string;
    readonly path: string;
    readonly loader: ModuleLoader;
    protected children: { [name: string]: ModuleProxy };
    protected singletons: { [name: string]: any };
    protected remoteSingletons: { [serverId: string]: any };

    get exports(): any {
        if (typeof this.loader.extension === "string") {
            return this.loader.load(this.path + this.loader.extension);
        } else {
            let dir = dirname(this.path);
            let name = basename(this.path);
            let files = readdirSync(dir);

            for (let file of files) {
                let ext = extname(file);
                let _name = basename(file, ext);

                if (_name === name && this.loader.extension.includes(ext)) {
                    return this.loader.load(this.path + ext);
                }
            }

            throw new Error(`Cannot find module '${this.path}'`);
        }
    }

    get proto(): any {
        let { exports } = this;

        if (typeof exports === "object") {
            if (typeof exports.default === "object") {
                return exports.default;
            } else if (typeOf(exports.default) === "class") {
                return exports.default.prototype;
            }

            return exports;
        } else if (typeOf(exports) === "class") {
            return exports.prototype;
        } else {
            return null;
        }
    }

    get ctor(): new (...args: any[]) => any {
        let { exports } = this;

        if (typeof exports === "object" && typeOf(exports.default) === "class") {
            return exports.default;
        } else if (typeOf(exports) === "class") {
            return exports;
        } else {
            return null;
        }
    }

    create(...args: any[]): any {
        if (this.ctor) {
            return new this.ctor(...args);
        } else if (this.proto) {
            return merge(cloneDeep(this.proto), args[0]);
        } else {
            throw new TypeError(`${this.name} is not a valid module`);
        }
    }

    instance(route: any = local): any {
        if (route === local) {
            return this.singletons[this.name] || (
                this.singletons[this.name] = getInstance(<any>this)
            );
        }

        // If the route matches any key of the remoteSingletons, return the
        // corresponding singleton as wanted.
        if (typeof route === "string" && this.remoteSingletons[route]) {
            return this.remoteSingletons[route];
        }

        let singletons = values(this.remoteSingletons);
        let count = singletons.length;

        if (count > 0) {
            let availableSingletons = singletons.filter(item => {
                return item[readyState] === 2;
            });
            let _count = availableSingletons.length;

            if (_count === 1) {
                return availableSingletons[0];
            } else if (_count >= 2) {
                // If the module is connected to more than one remote instances,
                // redirect traffic to one of them automatically.
                let id = evalRouteId(route);
                return availableSingletons[id % _count];
            } else if (count === 1) {
                return singletons[0];
            } else {
                let id = evalRouteId(route);
                return singletons[id % count];
            }
        }

        throwUnavailableError(this.name);
    }

    fallbackToLocal(): boolean;
    fallbackToLocal(enable: boolean): this;
    fallbackToLocal(enable: boolean = void 0): this | boolean {
        if (enable === void 0) {
            return this[fallbackToLocal];
        } else {
            this[fallbackToLocal] = Boolean(enable);
            return this;
        }
    }

    /** @deprecated */
    noLocal(): this {
        return this.fallbackToLocal(false);
    }

    protected __get(prop: string) {
        if (prop in this) {
            return this[prop];
        } else if (prop in this.children) {
            return this.children[prop];
        } else if (typeof prop != "symbol") {
            return this.children[prop] = createModuleProxy(
                this.name + "." + String(prop),
                this.path + sep + String(prop),
                this.loader,
                this.singletons,
                this[proxyRoot] || this
            );
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }

    toString() {
        return this.name;
    }

    toJSON() {
        return this.name;
    }
}