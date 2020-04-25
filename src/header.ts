import * as alar from ".";
import "@hyurl/utils/types";

type Voidable<T> = { [K in keyof T]: T[K] | void };
type EnsureInstanceType<T> = T extends new (...args: any[]) => infer R ? R : T;
type AsynchronizedFunctionProperties<T> = {
    [K in keyof FunctionProperties<T>]: Asynchronize<T[K]>;
};

declare global {
    interface ModuleProxy<T> {
        new(...args: T extends new (...args: infer A) => any ? A : any[]): EnsureInstanceType<T>;
        (local?: typeof alar.local): EnsureInstanceType<T>;
        (route: any): AsynchronizedFunctionProperties<EnsureInstanceType<T>> & Voidable<Readonly<NonFunctionProperties<EnsureInstanceType<T>>>>;

        /** The name (with namespace) of the module. */
        readonly name: string;
        /** The path (without extension) of the module. */
        readonly path: string;
        readonly loader: ModuleLoader;
        /** The very exports object of the module. */
        readonly exports: any;
        /** The very prototype of the module. */
        readonly proto: EnsureInstanceType<T>;
        /** The very class constructor of the module. */
        readonly ctor: T extends Function ? T : new (...args: any[]) => EnsureInstanceType<T>;

        /** Creates a new instance of the module. */
        create(...args: T extends new (...args: infer A) => any ? A : any[]): EnsureInstanceType<T>;

        /**
         * Gets the local singleton or a remote instance of the module, if 
         * connected to one or more remote instances, the module proxy will 
         * automatically calculate the `route` and direct the traffic to the 
         * corresponding remote instance.
         */
        instance(local?: typeof alar.local): EnsureInstanceType<T>;
        instance(route: any): AsynchronizedFunctionProperties<EnsureInstanceType<T>> & Voidable<Readonly<NonFunctionProperties<EnsureInstanceType<T>>>>;

        /**
         * If the module is registered as a remote service, however none of the
         * RPC channel is available, allow calls to fallback to the local
         * instance, which is the default behavior, this method is used to
         * disable (pass `false`) and re-enable (pass `true`) this behavior.
         */
        fallbackToLocal(enable: boolean): this;

        /**
         * Allowing the current module to be injected as a dependency bound to a
         * property of another class instance.
         * 
         * @deprecated
         */
        inject(route?: any): PropertyDecorator;

        /**
         * @deprecated use `fallbackToLocal(false)` instead.
         */
        noLocal(): this;
    }
}


export interface ModuleLoader {
    [x: string]: any;
    /**
     * Extension name of the module file, by default, it's `.js` (or `.ts` in 
     * ts-node).
     */
    extension: string | string[],
    /**
     * It is recommended using this property to store loaded modules, so that
     * the internal watcher can manipulate the cache when necessary.
     */
    cache?: { [filename: string]: any; };
    /** Loads module from the given file or cache. */
    load(filename: string): any;
    /** Unloads the module in the cache if the file is modified. */
    unload(filename: string): void;
}