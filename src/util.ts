import * as os from "os";
import * as path from "path";
import { AssertionError } from 'assert';
import pick = require("lodash/pick");
import omit = require("lodash/omit");
import startsWith = require("lodash/startsWith");

type ErrorObject = Error & { [x: string]: any };
const WinPipe = "\\\\?\\pipe\\";

export const local = Symbol("local");
export const remotized = Symbol("remotized");
export const noLocal = Symbol("noLocal");

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
    let props = ["name", "message", "stack"];
    return Object.assign({}, pick(err, props), omit(err, props)) as any;
}

export function obj2err(obj: ErrorObject): ErrorObject {
    let Errors = {
        AssertionError,
        Error,
        EvalError,
        RangeError,
        ReferenceError,
        SyntaxError,
        TypeError,
    };
    let err = Object.create((Errors[obj.name] || Error).prototype);
    let props = ["name", "message", "stack"];

    for (let prop in obj) {
        if (props.indexOf(prop) >= 0) {
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
    fnCreator: (ins: any, prop: string) => Function
) {

    // Generate a proxified singleton instance to the module, so that it can
    // be used for remote requests. the remote instance should only return
    // methods.
    return new Proxy(getInstance(mod, false), {
        get: (ins, prop: string) => {
            let isFn = typeof ins[prop] === "function";

            if (isFn && !ins[prop].proxified) {
                set(ins, prop, fnCreator(ins, prop));
            }

            return isFn ? ins[prop] : undefined;
        },
        has: (ins, prop: string) => {
            return typeof ins[prop] === "function";
        }
    });
}