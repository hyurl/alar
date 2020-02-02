import * as os from "os";
import * as path from "path";
import startsWith = require("lodash/startsWith");
import { ModuleProxy as ModuleProxyBase } from "./proxy";
import { BSP } from "bsp";
import { clone, declone } from "@hyurl/structured-clone";
import isOwnKey from "@hyurl/utils/isOwnKey";
import { ModuleLoader } from './header';

const WinPipe = "\\\\?\\pipe\\";
export const local = Symbol("local");
export const proxyRoot = Symbol("proxyRoot");

/**
 * - 0: not ready (default)
 * - 1: initiating
 * - 2: ready
 * - 3: destroying
 */
export const readyState = Symbol("readyState");

export function absPath(filename: string, withPipe?: boolean): string {
    // resolve path to be absolute
    if (!path.isAbsolute(filename)) {
        filename = path.resolve(process.cwd(), filename);
    }

    if (withPipe && os.platform() == "win32" && !startsWith(filename, WinPipe)) {
        filename = WinPipe + filename;
    }

    return filename;
}

export function set(
    target: any,
    prop: any,
    value: any,
    writable = false,
    enumerable = false
) {
    Object.defineProperty(target, prop, {
        configurable: true,
        enumerable,
        writable,
        value
    });
}

export function getInstance(mod: ModuleProxy<any>, forRemote = false) {
    let ins: any;
    let { ctor } = mod;

    if (ctor) {
        if (!forRemote) {
            if (typeof ctor.getInstance === "function") {
                ins = ctor.getInstance();
            } else {
                ins = mod.create();
            }
        } else {
            // Create instance without instantiating, used for remote instance.
            ins = Object.create(ctor.prototype);
        }
    } else {
        ins = <any>mod.proto;
    }

    return ins;
}

export function mergeFnProperties(fn: Function, origin: Function) {
    set(fn, "proxified", true);
    set(fn, "name", origin.name);
    set(fn, "length", origin.length);
    set(fn, "toString", function toString() {
        return "[ModuleProxy] " + Function.prototype.toString.call(origin);
    }, true);

    return fn;
}

export function createRemoteInstance(
    mod: ModuleProxy<any>,
    fnCreator: (prop: string) => Function
) {

    // Generate a proxified singleton instance to the module, so that it can
    // be used for remote requests. the remote instance should only return
    // methods.
    return new Proxy(getInstance(mod, true), {
        get: (ins, prop: string | symbol) => {
            if (typeof prop === "symbol") {
                return ins[prop];
            }

            let type = typeof ins[prop];
            let isFn = type === "function";

            if (isFn && !ins[prop]["proxified"] && !isOwnKey(ins, prop)) {
                set(
                    ins,
                    prop,
                    mergeFnProperties(fnCreator(<string>prop), ins[prop])
                );
            }

            return isFn ? ins[prop] : (type === "undefined" ? undefined : null);
        },
        has: (ins, prop: string | symbol) => {
            return typeof prop === "symbol"
                ? (prop in ins)
                : typeof ins[prop] === "function";
        }
    });
}

export function humanizeDuration(duration: number): string {
    let num: number;
    let unit: string;

    if (duration < 1000) {
        num = duration;
        unit = "millisecond";
    } else if (duration < 60000) {
        num = Math.round(duration / 1000);
        unit = "second";
    } else {
        num = Math.round(duration / 60000);
        unit = "minute";
    }

    if (num !== 1)
        unit += "s";

    return num + " " + unit;
}

export async function tryLifeCycleFunction(
    mod: ModuleProxy<{ init?(): any, destroy?(): any }>,
    fn: "init" | "destroy",
    errorHandle: (err: Error) => void = void 0
) {
    let ins = mod();

    if (fn === "init") {
        if (typeof ins.init === "function") {
            ins[readyState] = 1; // initiating

            if (errorHandle) {
                try { await ins.init() } catch (err) { errorHandle(err) }
            } else {
                await ins.init();
            }
        }

        ins[readyState] = 2; // ready
    } else if (fn === "destroy") {
        if (typeof ins.destroy === "function") {
            ins[readyState] = 3; // destroying

            if (errorHandle) {
                try { await ins.destroy() } catch (err) { errorHandle(err) }
            } else {
                await ins.destroy();
            }
        }

        ins[readyState] = 0; // not ready
    }
}

export function throwNotAvailableError(name: string) {
    throw new ReferenceError(`Service ${name} is not available`);
}

export function getCodecOptions(
    codec: "JSON" | "CLONE" | "BSON" | "FRON"
): ConstructorParameters<typeof BSP>[0] {
    switch (codec) {
        case "JSON":
            return {
                objectSerializer: JSON.stringify,
                objectDeserializer: JSON.parse
            };

        case "CLONE":
            return {
                objectSerializer: (data: any) => JSON.stringify(clone(data)),
                objectDeserializer: (data: string) => declone(JSON.parse(data))
            };

        case "FRON": {
            let FRON: JSON = require("fron");

            return {
                objectSerializer: FRON.stringify,
                objectDeserializer: FRON.parse
            };
        }

        case "BSON": {
            let BSON: { serialize: Function, deserialize: Function };

            try {
                let BSONExt = require("bson-ext");
                BSON = new BSONExt([
                    BSONExt.Binary,
                    BSONExt.Code,
                    BSONExt.DBRef,
                    BSONExt.Decimal128,
                    BSONExt.Double,
                    BSONExt.Int32,
                    BSONExt.Long,
                    BSONExt.Map,
                    BSONExt.MaxKey,
                    BSONExt.MinKey,
                    BSONExt.ObjectId,
                    BSONExt.BSONRegExp,
                    BSONExt.Symbol,
                    BSONExt.Timestamp
                ]);
            } catch (e) {
                try {
                    BSON = require("bson");
                } catch (e) {
                    throw new Error("Cannot find module 'bson' or 'bson-ext'");
                }
            }

            return {
                objectSerializer: BSON.serialize.bind(BSON),
                objectDeserializer: BSON.deserialize.bind(BSON),
                serializationStyle: "buffer"
            };
        }
    }
}

export function patchProperties(
    target: ModuleProxyBase,
    filename: string,
    loader: ModuleLoader,
    singletons: { [name: string]: any }
) {
    set(target, "path", path.normalize(filename), false, true);
    set(target, "loader", loader);
    set(target, "singletons", singletons);
    set(target, "remoteSingletons", dict());
    set(target, "children", dict());
}

export function dict(): { [x: string]: any } {
    return Object.create(null);
}