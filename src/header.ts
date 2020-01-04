declare global {
    type FunctionPropertyNames<T> = {
        [K in keyof T]: T[K] extends Function ? K : never
    }[keyof T];
    type NonFunctionPropertyNames<T> = {
        [K in keyof T]: T[K] extends Function ? never : K
    }[keyof T];
    type FunctionProperties<T> = Pick<T, FunctionPropertyNames<T>>;
    type NonFunctionProperties<T> = Pick<T, NonFunctionPropertyNames<T>>;
    type AsynchronizedFunctionProperties<T> = {
        [K in keyof FunctionProperties<T>]: ReturnType<T[K]> extends Promise<any>
        ? T[K]
        : (ReturnType<T[K]> extends (AsyncIterableIterator<infer U> | IterableIterator<infer U>)
            ? (...args: Parameters<T[K]>) => AsyncIterableIterator<U> & Promise<U>
            : (...args: Parameters<T[K]>) => Promise<ReturnType<T[K]>>
        );
    }

    type Voidable<T> = { [K in keyof T]: T[K] | void }
    type EnsureInstanceType<T> = T extends new (...args: any[]) => infer R ? R : T;

    interface ModuleConstructor<T> {
        new(...args: any[]): T;
        getInstance?(): T;
    }

    interface ModuleProxy<T> {
        new(...args: T extends new (...args: infer A) => any ? A : any[]): EnsureInstanceType<T>;
        (local: symbol): AsynchronizedFunctionProperties<EnsureInstanceType<T>> & Readonly<NonFunctionProperties<EnsureInstanceType<T>>>;
        (route?: any): AsynchronizedFunctionProperties<EnsureInstanceType<T>> & Voidable<Readonly<NonFunctionProperties<EnsureInstanceType<T>>>>;

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
        readonly ctor: ModuleConstructor<EnsureInstanceType<T>>;

        /** Creates a new instance of the module. */
        create(...args: T extends new (...args: infer A) => any ? A : any[]): EnsureInstanceType<T>;

        /**
         * Gets the local singleton or a remote instance of the module, if 
         * connected to one or more remote instances, the module proxy will 
         * automatically calculate the `route` and direct the traffic to the 
         * corresponding remote instance.
         */
        instance(local: symbol): AsynchronizedFunctionProperties<EnsureInstanceType<T>> & Readonly<NonFunctionProperties<EnsureInstanceType<T>>>;
        instance(route?: any): AsynchronizedFunctionProperties<EnsureInstanceType<T>> & Voidable<Readonly<NonFunctionProperties<EnsureInstanceType<T>>>>;

        /**
         * Allowing the current module to be injected as a dependency bound to a
         * property of another class instance.
         */
        inject(route?: any): PropertyDecorator;

        /**
         * If the module is registered as remote service, however when no RPC 
         * channel is available, by default, `instance()` will fail to the local
         * instance, using this method to disable the default behavior.
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
    cache?: { [filename: string]: any };
    /** Loads module from the given file or cache. */
    load(filename: string): any;
    /** Unloads the module in cache if the file is modified. */
    unload(filename: string): void;
}