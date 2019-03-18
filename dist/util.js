"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const os = require("os");
const path = require("path");
const assert_1 = require("assert");
const pick = require("lodash/pick");
const omit = require("lodash/omit");
const startsWith = require("lodash/startsWith");
const thenable_generator_1 = require("thenable-generator");
const WinPipe = "\\\\?\\pipe\\";
exports.local = Symbol("local");
exports.remotized = Symbol("remotized");
exports.noLocal = Symbol("noLocal");
function absPath(filename, withPipe) {
    if (!path.isAbsolute(filename)) {
        filename = path.resolve(process.cwd(), filename);
    }
    if (withPipe && os.platform() == "win32" && !startsWith(filename, WinPipe)) {
        filename = WinPipe + filename;
    }
    return filename;
}
exports.absPath = absPath;
function set(target, prop, value, writable = false) {
    Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        writable,
        value
    });
}
exports.set = set;
function getInstance(mod, instantiate = true) {
    let ins;
    let { ctor } = mod;
    if (ctor) {
        if (instantiate) {
            if (typeof ctor.getInstance === "function") {
                ins = ctor.getInstance();
            }
            else {
                ins = mod.create();
            }
        }
        else {
            ins = Object.create(ctor.prototype);
        }
    }
    else {
        ins = mod.proto;
    }
    return ins;
}
exports.getInstance = getInstance;
function err2obj(err) {
    if (!(err instanceof Error))
        return err;
    let props = ["name", "message", "stack"];
    return Object.assign({}, pick(err, props), omit(err, props));
}
exports.err2obj = err2obj;
function obj2err(obj) {
    let Errors = {
        AssertionError: assert_1.AssertionError,
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
        }
        else {
            err[prop] = obj[prop];
        }
    }
    return err;
}
exports.obj2err = obj2err;
function mergeFnProperties(fn, origin) {
    set(fn, "proxified", true);
    set(fn, "name", origin.name);
    set(fn, "length", origin.length);
    set(fn, "toString", function toString() {
        return Function.prototype.toString.call(origin);
    }, true);
    return fn;
}
exports.mergeFnProperties = mergeFnProperties;
function createRemoteInstance(mod, fnCreator) {
    return new Proxy(getInstance(mod, false), {
        get: (ins, prop) => {
            let type = typeof ins[prop];
            let isFn = type === "function";
            if (isFn && !ins[prop].proxified) {
                set(ins, prop, mergeFnProperties(fnCreator(prop), ins[prop]));
            }
            return isFn ? ins[prop] : (type === "undefined" ? undefined : null);
        },
        has: (ins, prop) => {
            return typeof ins[prop] === "function";
        }
    });
}
exports.createRemoteInstance = createRemoteInstance;
function generable(origin) {
    return function (...args) {
        try {
            let res = origin.apply(this, args);
            if (res && typeof res[Symbol.asyncIterator] === "function") {
                return new thenable_generator_1.ThenableAsyncGenerator(res);
            }
            else if (res && typeof res[Symbol.iterator] === "function") {
                return new thenable_generator_1.ThenableGenerator(res);
            }
            else {
                return res;
            }
        }
        catch (err) {
            throw err;
        }
    };
}
function createLocalInstance(mod) {
    return new Proxy(getInstance(mod), {
        get: (ins, prop) => {
            if (typeof ins[prop] === "function" && !ins[prop].proxified) {
                let origin = ins[prop];
                set(ins, prop, mergeFnProperties(generable(origin), origin));
            }
            return ins[prop];
        }
    });
}
exports.createLocalInstance = createLocalInstance;
//# sourceMappingURL=util.js.map