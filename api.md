# ModuleProxy

```typescript
interface ModuleProxy<T, R1 = any, R2 = any, R3 = any, R4 = any, R5 = any>
```

Once Alar is imported to the project, this interface will be presented under 
the global namespace, and can be used everywhere.

The interface has the following properties and methods:

- `name: string` The name (with namespace) of the module.
- `path: string` The path (without extension) of the module.
- `exports: any` The very exports object of the module.
- `proto: object` The very prototype of the module.
- `ctor: ModuleConstructor<T>` The very class constructor of the module.
- `create()` Creates a new instance of the module.
    - `create(arg1: R1): T`
    - `create(arg1: R1, arg2: R2): T`
    - `create(arg1: R1, arg2: R2, arg3: R3): T`
    - `create(arg1: R1, arg2: R2, arg3: R3, arg4: R4): T`
    - `create(arg1: R1, arg2: R2, arg3: R3, arg4: R4, arg5: R5): T`
    - `create(...args: any[]): T`
- `instance(ins?: T): T` Sets/Gets the singleton instance of the module.
- `remote(route?: any): T` Gets a remote instance connected according to 
    the `route`. The module proxy will automatically calculate the route and 
    direct the traffic to the corresponding remote instance.

# ModuleConstructor

This interface will be globalized as well, it indicates the very class 
constructor of the module. 

```typescript
interface ModuleConstructor<T> {
    new(...args: any[]): T;
    getInstance?(): T;
}
```

- `getInstance?(): T` If the class defines this static method, when calling 
    `ModuleProxy<T>.instance()`, it will get the returning instance as the 
    singleton instead.

# ModuleProxy (class)

```typescript
class ModuleProxy { constructor(name: string, path: string) }
```

This class must be imported in order to create a root module proxy, and the root
module should be declared as a namespace under the global scope, in TypeScript,
the following steps must be walked though for Alar to work in a project.

```typescript
import { ModuleProxy } from "alar";

// This statement creates a root module and assign it to the global scope in 
// NodeJS env.
export const App = global["app"] = new ModuleProxy("app", __dirname);

// This declaration merging creates a namespace app under the global scope in
// TypeScript, so you can use it everywhere for type hint and type check.
declare global {
    namespace app { }
}
```

This class is actually the base of global interface ModuleProxy, and it has the 
following extra properties and methods:

- `serve(config: string | RpcOptions): Promise<RpcChannel>` Serves an RPC 
    service according to the given configuration.
- `connect(config: string | RpcOptions): Promise<RpcChannel>` Connects an RPC 
    service according to the given configuration.
- `resolve(path: string): string` Resolves the given path to a module name.
- `watch(listener?: (event: "change" | "unlink", filename: string)): FSWatcher` 
    Watches file change and reload the corresponding module.
    - `listener` if provided, it will be called after the module cache has been
        cleared.
    - `FSWatcher` is a type exposed by 
        [chokidar](https://github.com/paulmillr/chokidar).
- `setLoader(loader: ModuleLoader): void` Sets a custom loader to resolve the 
    module.

# ModuleLoader

```typescript
export interface ModuleLoader {
    extesion: string,
    load(path: string): any;
    unload(path: string): void;
}
```

By default, Alar supports JavaScript modules and (TypeScript modules in 
**ts-node**), By setting a custom loader, a ModuleProxy instance can resolve any
kind of module wanted. NOTE: The loader must provide cache support.

- `extesion` Extension name of the module file, by default, it's `.js` (or `.ts`
    in ts-node).
- `load(filename: string): any` Loads module from the given file or cache.
- `unload(filename: string): void` Unloads the module in cache if the file is 
    modified.

```typescript
// Add a loader to resolve JSON modules.
var json = new alar.ModuleProxy("json", __dirname + "/json");
var cache = {};

json.setLoader({
    extesion: ".json",
    load(path) {
        return cache[path] || (
            cache[path] = JSON.parse(fs.readFileSync(path + this.extesion, "utf8"))
        );
    },
    unload(path) {
        cache[path] && (delete cache[path]);
    }
});
```

# RpcOptions

```typescript
interface RpcOptions {
    host?: string;
    port?: number;
    path?: string;
    timeout?: number;
}
```

If `path` is provided (equivalent to `ModuleProxy.serve(config: string)` and 
`ModuleProxy.connect(config: string)`), the RPC channel will be bound to an IPC 
channel. Otherwise, the RPC channel will be bound a network channel according to
the `host` and `port`. By default `timeout` is set `5000`ms, works both in 
connection and IPC requests.

The channel provides internal support for re-connection, if a remote service is 
disconnected e.g. the server shutdown (even manually), the traffic will be 
redirected to other online services, and the client will try to reconnect 
repeatedly in the background (according to `timeout`).

# RpcChannel

```typescript
abstract class RpcChannel implements RpcOptions { }
```

This abstract class just indicates the RPC channel that allows modules to 
communicate remotely. `ModuleProxy.serve()` and `ModuleProxy.connect()` return 
its server and client implementations.

The following properties and methods work in both implementations:

- `dns: string` Gets the data source name according to the configuration.
- `open(): Promise<this>` Opens the channel. This method is internally called by
    `ModuleProxy.serve()` and `ModuleProxy.connect()`, you don't have to call it.
- `close(): Promise<this>` Closes the channel.
- `register<T>(mod: ModuleProxy<T>): this` Registers a module proxy to the 
    channel.
- `onError(handler: (err: Error) => void)` Binds an error handler invoked 
    whenever an error occurred in asynchronous operations which can't be caught
    during run-time.

# RpcServer

```typescript
class RpcServer extends RpcChannel { }
```

The server implementation of the RPC channel.

# RpcClient

```typescript
class RpcClient extends RpcChannel { }
```

The client implementation of the RPC channel.

- `connecting: boolean` Whether the channel is in connecting state.
- `connected: boolean` Whether the channel is connected.
- `closed: boolean` Whether the channel is closed.
- `pause(): boolean`  Pauses the channel and redirect traffic to other channels.
- `resume(): boolean` Resumes the channel and continue handling traffic.