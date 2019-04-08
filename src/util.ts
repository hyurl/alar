import * as os from "os";
import * as path from "path";
import { AssertionError } from 'assert';
import pick = require("lodash/pick");
import omit = require("lodash/omit");
import startsWith = require("lodash/startsWith");
import { ThenableAsyncGenerator, ThenableGenerator } from 'thenable-generator';

type ErrorObject = Error & { [x: string]: any };
const WinPipe = "\\\\?\\pipe\\";
const ErrorProps = ["name", "message", "stack"];

export const local = Symbol("local");
export const remotized = Symbol("remotized");
export const noLocal = Symbol("noLocal");
export const Errors: { [name: string]: new (...args: any[]) => Error } = {
    AssertionError,
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError
};

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

export function err2obj(err: ErrorObject): ErrorObject {
    if (!(err instanceof Error)) return err;

    return <any>Object.assign({}, pick(err, ErrorProps), omit(err, ErrorProps));
}

export function obj2err(obj: ErrorObject): ErrorObject {
    let err = Object.create((Errors[obj.name] || Error).prototype);

    for (let prop in obj) {
        if (ErrorProps.indexOf(prop) >= 0) {
            set(err, prop, obj[prop], true);
        } else {
            err[prop] = obj[prop];
        }
    }

    return err;
}

export function mergeFnProperties(fn: Function, origin: Function) {
    set(fn, "proxified", true);
    set(fn, "name", origin.name);
    set(fn, "length", origin.length);
    set(fn, "toString", function toString() {
        return Function.prototype.toString.call(origin);
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

            if (isFn && !ins[prop].proxified) {
                set(ins, prop, mergeFnProperties(fnCreator(prop), ins[prop]));
            }

            return isFn ? ins[prop] : (type === "undefined" ? undefined : null);
        },
        has: (ins, prop: string) => {
            return typeof ins[prop] === "function";
        }
    });
}

function generable(origin: Function) {
    return function (this: any, ...args: any[]) {
        try {
            let res = origin.apply(this, args);

            if (res && typeof res[Symbol.asyncIterator] === "function") {
                return new ThenableAsyncGenerator(res);
            } else if (res && typeof res[Symbol.iterator] === "function") {
                return new ThenableGenerator(res);
            } else {
                return res;
            }
        } catch (err) {
            throw err;
        }
    };
}

export function createLocalInstance(mod: ModuleProxy<any>) {
    return new Proxy(getInstance(mod), {
        get: (ins, prop: string) => {
            if (typeof ins[prop] === "function" && !ins[prop].proxified) {
                let origin: Function = ins[prop];

                set(ins, prop, mergeFnProperties(generable(origin), origin));
            }

            return ins[prop];
        }
    });
}