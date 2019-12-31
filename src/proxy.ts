import hash = require("string-hash");
import { sep, dirname, basename, extname } from "path";
import { applyMagic } from "js-magic";
import { ModuleLoader } from './index';
import { Injectable } from "./di";
import { readdirSync } from 'fs';
import cloneDeep = require("lodash/cloneDeep");
import merge = require("lodash/merge");
import { clone } from "@hyurl/structured-clone";
import isClass from "could-be-class";
import {
    createLocalInstance,
    local,
    remotized,
    noLocal,
    set,
    RpcState,
    patchProperties
} from './util';

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
export function createModuleProxy<T = any>(
    name: string,
    path: string,
    loader?: ModuleLoader,
    singletons?: { [name: string]: any }
): ModuleProxy<T> {
    let proxy = function (route: any) {
        return (<any>proxy).instance(route);
    };

    Object.setPrototypeOf(proxy, ModuleProxy.prototype);
    set(proxy, "name", name);
    patchProperties(<any>proxy, path, loader || defaultLoader, singletons || {});

    return <any>applyMagic(proxy, true);
}


@applyMagic
export abstract class ModuleProxy<T = any> extends Injectable implements ModuleProxy<T> {
    abstract readonly name: string;
    readonly path: string;
    readonly loader: ModuleLoader;
    protected singletons: { [name: string]: T };
    protected remoteSingletons: { [serverId: string]: T };
    protected children: { [name: string]: ModuleProxy<any> };

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

    get proto(): EnsureInstanceType<T> {
        let { exports } = this;

        if (typeof exports === "object") {
            if (typeof exports.default === "object") {
                return exports.default;
            } else if (
                typeof exports.default === "function" &&
                isClass(exports.default, true)
            ) {
                return exports.default.prototype;
            }

            return exports;
        } else if (typeof exports === "function" && isClass(exports, true)
        ) {
            return exports.prototype;
        } else {
            return null;
        }
    }

    get ctor(): ModuleConstructor<EnsureInstanceType<T>> {
        let { exports } = this;

        if (
            typeof exports === "object" &&
            isClass(exports.default, true)
        ) {
            return exports.default;
        } else if (typeof exports === "function" && isClass(exports, true)) {
            return exports;
        } else {
            return null;
        }
    }

    create(...args: any[]): EnsureInstanceType<T> {
        if (this.ctor) {
            return new this.ctor(...args);
        } else if (this.proto) {
            return merge(cloneDeep(this.proto), args[0]);
        } else {
            throw new TypeError(`${this.name} is not a valid module`);
        }
    }

    instance(route: any = "", ignoreState = false): any {
        // If the route matches the any key of the remoteSingletons, return the
        // corresponding singleton as wanted.
        if (typeof route === "string" && this.remoteSingletons[route]) {
            return this.remoteSingletons[route];
        }

        let keys = Object.keys(this.remoteSingletons);

        if (route === local || !this[remotized] ||
            (!keys.length && !this[noLocal])
        ) {
            if (this[RpcState] && this[RpcState] !== 1 &&
                this.singletons[this.name] && !ignoreState
            ) {
                throw new ReferenceError(
                    `Service ${this.name} is not available`
                );
            }

            return this.singletons[this.name] || (
                this.singletons[this.name] = createLocalInstance(<any>this)
            );
        } else if (keys.length) {
            // If the module is connected to one or more remote instances,
            // redirect traffic to one of them automatically.
            let num = hash(JSON.stringify(clone(route)));
            let id = keys[num % keys.length];
            return this.remoteSingletons[id];
        } else {
            throw new ReferenceError(`Service ${this.name} is not available`);
        }
    }

    remote(route: any = "") {
        return this.instance(route);
    }

    noLocal(): this {
        this[noLocal] = true;
        return this;
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
                this.singletons
            );
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}