import * as os from "os";
import * as path from "path";
import startsWith = require("lodash/startsWith");
import { ThenableAsyncGenerator } from 'thenable-generator';
import { isAsyncGenerator, isGenerator } from "check-iterable";
import { ModuleProxyBase } from '.';

const WinPipe = "\\\\?\\pipe\\";

export const local = Symbol("local");
export const remotized = Symbol("remotized");
export const noLocal = Symbol("noLocal");
export const RpcState = Symbol("RpcState");

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

export function set(target: any, prop: any, value: any, writable = false) {
    Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        writable,
        value
    });
}

export function getInstance<T>(mod: ModuleProxy<T>, instantiate = true): T {
    let ins: T;
    let { ctor } = mod;

    if (ctor) {
        if (instantiate) {
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
    return new Proxy(getInstance(mod, false), {
        get: (ins, prop: string) => {
            let type = typeof ins[prop];
            let isFn = type === "function";

            if (isFn && !ins[prop].proxified
                && !(<Object>ins).hasOwnProperty(prop)
            ) {
                set(ins, prop, mergeFnProperties(fnCreator(prop), ins[prop]));
            }

            return isFn ? ins[prop] : (type === "undefined" ? undefined : null);
        },
        has: (ins, prop: string) => {
            return typeof ins[prop] === "function";
        }
    });
}

export function createLocalInstance(mod: ModuleProxy<any>) {
    return new Proxy(getInstance(mod), {
        get: (ins, prop: string) => {
            if (typeof ins[prop] === "function"
                && !ins[prop].proxified
                && !(<Object>ins).hasOwnProperty(prop)
            ) {
                let origin: Function = ins[prop];

                set(ins,
                    prop,
                    mergeFnProperties(asynchronize(origin, ins), origin),
                    true);
            }

            return ins[prop];
        }
    });
}

function asynchronize(origin: Function, thisArg: any) {
    return function (...args: any[]) {
        try {
            let res = origin.apply(thisArg, args);

            if (res) {
                if (isAsyncGenerator(res) || isGenerator(res)) {
                    return new ThenableAsyncGenerator(res);
                } else if (typeof res["then"] === "function") {
                    return res;
                }
            }

            return Promise.resolve(res);
        } catch (err) {
            return Promise.reject(err);
        }
    };
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
    mod: ModuleProxyBase,
    fn: "init" | "destroy"
) {
    if (RpcState in mod &&
        typeof mod.instance(local, true)[fn] === "function") {
        await mod.instance(local, true)[fn]();
    }
}