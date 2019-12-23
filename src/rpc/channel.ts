import { absPath, getCodecOptions } from '../util';
import { BSP } from "bsp";

export interface RpcOptions {
    [x: string]: any;
    host?: string;
    port?: number;
    path?: string;
    secret?: string;
    id?: string;
    codec?: "CLONE" | "JSON" | "BSON" | "FRON"
}

export type Request = [number, number | string, string?, string?, ...any[]];
export type Response = [number, number | string, any];
export enum RpcEvents {
    HANDSHAKE,
    CONNECT,
    BROADCAST,
    INVOKE,
    RETURN,
    YIELD,
    THROW,
    PING,
    PONG
}

/** An RPC channel that allows modules to communicate remotely. */
export abstract class RpcChannel implements RpcOptions {
    readonly host: string = "0.0.0.0";
    readonly port: number = 9000;
    readonly path: string = "";
    readonly secret?: string;
    readonly codec: RpcOptions["codec"];
    protected bsp: BSP;
    protected errorHandler: (err: Error) => void;

    constructor(path: string);
    constructor(port: number, host?: string);
    constructor(options: RpcOptions);
    constructor(options: string | number | RpcOptions, host?: string) {
        if (typeof options === "object") {
            Object.assign(this, options);
        } else if (typeof options === "number") {
            Object.assign(this, { host, port: options });
        } else {
            this.path = absPath(options);
        }

        this.codec || (this.codec = "CLONE");
        this.bsp = new BSP(getCodecOptions(this.codec));
    }

    /** Gets the data source name according to the configuration. */
    get dsn() {
        let dsn = this.path ? "ipc://" : "rpc://";

        if (this.path) {
            dsn += this.path;
        } else if (this.port) {
            if (this.host) {
                dsn += this.host + ":";
            }
            dsn += this.port;
        }

        return dsn;
    }

    /**
     * Binds an error handler invoked whenever an error occurred in asynchronous
     * operations which can't be caught during run-time.
     */
    onError(handler: (err: Error) => void) {
        this.errorHandler = handler;
    }

    /**
     * Registers a new type of error so that the channel can transmit it.
     * @deprecated Simply just add the error constructor to the global scope
     *  will do fine.
     */
    static registerError(ctor: new (...args: any) => Error) {
        global[ctor.name] = ctor;
    }

    /** Opens the channel. */
    abstract open(): Promise<this>;

    /** Closes the channel. */
    abstract close(): Promise<this>;

    /** Registers a module proxy to the channel. */
    abstract register<T extends object>(mod: ModuleProxy<T>): this;
}