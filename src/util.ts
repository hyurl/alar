import * as os from "os";
import * as path from "path";
import { AssertionError } from 'assert';
import pick = require("lodash/pick");
import omit = require("lodash/omit");

type ErrorObject = Error & { [x: string]: any };
const WinPipe = /\\\\[\?\.]\\pipe\\/i;

export function absPath(filename: string, withPipe?: boolean): string {
    // resolve path to be absolute
    if (!path.isAbsolute(filename)) {
        filename = path.resolve(process.cwd(), filename);
    }

    if (withPipe && os.platform() == "win32" && !(WinPipe.test(filename))) {
        filename = "\\\\?\\pipe\\" + filename;
    }

    return filename;
}

export function set(target, prop, value, writable = false) {
    Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        writable,
        value
    });
}

export function getInstance<T>(mod: ModuleProxy<T>): T {
    let ins: T;

    if (typeof mod.ctor.getInstance === "function") {
        ins = mod.ctor.getInstance();
    } else {
        try {
            ins = mod.create();
        } catch (err) {
            ins = Object.create(mod.ctor.prototype);
        }
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