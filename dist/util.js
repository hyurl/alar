"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const os = require("os");
const path = require("path");
const assert_1 = require("assert");
const pick = require("lodash/pick");
const omit = require("lodash/omit");
const WinPipe = /\\\\[\?\.]\\pipe\\/i;
function absPath(filename, withPipe) {
    if (!path.isAbsolute(filename)) {
        filename = path.resolve(process.cwd(), filename);
    }
    if (withPipe && os.platform() == "win32" && !(WinPipe.test(filename))) {
        filename = "\\\\?\\pipe\\" + filename;
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
function getInstance(mod) {
    let ins;
    let { ctor } = mod;
    if (ctor && typeof ctor.getInstance === "function") {
        ins = ctor.getInstance();
    }
    else if ((ins = mod.proto) === null) {
        ins = mod.create();
    }
    return ins;
}
exports.getInstance = getInstance;
function err2obj(err) {
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
//# sourceMappingURL=util.js.map