# ModuleProxy

```typescript
interface ModuleProxy<T, R1 = any, R2 = any, R3 = any, R4 = any, R5 = any>
```

Once separ is imported to the project, this interface will be presented under 
the global namespace, and can be used everywhere.

The interface has the following properties and methods:

- `name: string` The name (with namespace) of the module.
- `path: string` The path (without extension) of the module.
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
class ModuleProxy
```

This class must be imported in order to create a root module proxy, and the root
module should be declared as a namespace under the global scope, in TypeScript,
the following steps must be walked though for separ to work in a project.

```typescript
import { ModuleProxy } from "separ";

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
- `watch(): FSWatcher` Watches file change and reload the corresponding module.
    - `FSWatcher` is a type exposed by 
        [chokidar](https://github.com/paulmillr/chokidar).

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