import hash = require("string-hash");
import objectHash = require("object-hash");
import { sep, normalize, dirname, basename, extname } from "path";
import { applyMagic } from "js-magic";
import { createLocalInstance, local, remotized, noLocal, set } from './util';
import { ModuleLoader } from './index';
import { deprecate } from "util";
import { Injectable } from "./di";
import { readdirSync } from 'fs';
import cloneDeep = require("lodash/cloneDeep");
import merge = require("lodash/merge");

const cmd = process.execArgv.concat(process.argv).join(" ");
const isTsNode = cmd.includes("ts-node");
const defaultLoader: ModuleLoader = {
    extension: isTsNode ? ".ts" : ".js",
    load: require,
    unload(filename) {
        delete require.cache[filename];
    }
}

@applyMagic
export class ModuleProxyBase<T = any> extends Injectable implements ModuleProxy<T> {
    readonly path: string;
    readonly loader: ModuleLoader = defaultLoader;
    protected singletons: { [name: string]: T } = {};
    protected remoteSingletons: { [serverId: string]: T } = {};
    protected children: { [name: string]: ModuleProxy<any> } = {};

    constructor(readonly name: string, path: string) {
        super();
        this.path = normalize(path);
    }

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
            // return Object.create(<any>this.proto);
            return merge(cloneDeep(this.proto), args[0]);
        } else {
            throw new TypeError(`${this.name} is not a valid module`);
        }
    }

    instance(route: any = ""): T {
        // If the route matches the any key of the remoteSingletons, return the
        // corresponding singleton as wanted.
        if (typeof route === "string" && this.remoteSingletons[route]) {
            return this.remoteSingletons[route];
        }

        let keys = Object.keys(this.remoteSingletons);

        if (route === local || !this[remotized] || (!keys.length && !this[noLocal])) {
            return this.singletons[this.name] || (
                this.singletons[this.name] = createLocalInstance(<any>this)
            );
        } else if (keys.length) {
            // If the module is connected to one or more remote instances,
            // redirect traffic to one of them automatically.
            let id = keys[hash(objectHash(route)) % keys.length];
            return this.remoteSingletons[id];
        } else {
            throw new ReferenceError(`Service ${this.name} is not available`);
        }
    }

    remote(route: any = ""): T {
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
            let child = new ModuleProxyBase(
                this.name + "." + String(prop),
                this.path + sep + String(prop)
            );

            child.singletons = this.singletons;
            set(child, "loader", this.loader);

            return this.children[prop] = child;
        }
    }

    protected __has(prop: string) {
        return (prop in this) || (prop in this.children);
    }
}

ModuleProxyBase.prototype.remote = deprecate(
    ModuleProxyBase.prototype.remote,
    "ModuleProxy<T>.route() has been deprecated, use ModuleProxy<T>.instance() instead"
);