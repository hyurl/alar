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
- `instance(route?: any): T` Gets the local singleton or a remote instance of 
    the module, if connected to one or more remote instances, the module proxy 
    will automatically calculate the `route` and direct the traffic to the 
    corresponding remote instance. If the given route matches the DSN of any 
    remote service, the corresponding singleton will be returned instead.
- `inject(route?: any): PropertyDecorator` Allowing the current module to be 
    injected as a dependency bound to a property of another class instance.
- `noLocal(): this` If the module is registered as remote service, however when 
    no RPC channel is available, by default, `instance()` will fail to the local 
    instance, using this method to disable the default behavior.

**NOTE: IPC/RPC calling will serialize the data via JSON, those data that cannot**
**be serialized will get lost during transmission.**

**NOTE: properties cannot be accessed remotely, if trying so, `null` or**
**`undefined` will be returned instead, so it's better to declare properties**
**`protected` or `private` in any service class that may potentially served**
**remotely.**

*History version of Alar provides a `remote()` method to access remote ability,*
*however since 3.0, with a little API change, `remote()` has been merged to*
*`instance()` and is deprecated.*

# ModuleConstructor

This interface will be globalized as well, it indicates the very class 
constructor of the module (default export).

```typescript
interface ModuleConstructor<T> {
    new(...args: any[]): T;
    getInstance?(): T;
}
```

- `getInstance?(): T` If the class defines this static method, when calling 
    `ModuleProxy<T>.instance()`, it will get the returning instance as the 
    singleton instead.

# ModuleProxyBase

```typescript
class ModuleProxyBase<T = any> implements ModuleProxy<T> { }
```

This class is internally used to create chained module proxies.

# ModuleProxy (class)

```typescript
class ModuleProxy extends ModuleProxyBase {
    constructor(name: string, path: string);
}
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

This class has the following extra properties and methods:

- `local: symbol` If passed to the `ModuleProxy<T>.instance()`, the method will 
    always return the local instance.
- `serve(config: string | RpcOptions): Promise<RpcServer>` Serves an RPC 
    service according to the given configuration.
- `connect(config: string | ClientOptions): Promise<RpcClient>` Connects an RPC 
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

**NOTE: although `ModuleProxy` inherits from `ModuleProxyBase`, calling the**
**methods like `create()`, `instance()` should be avoided.**

# ModuleLoader

```typescript
export interface ModuleLoader {
    extension: string,
    load(path: string): any;
    unload(path: string): void;
}
```

By default, Alar supports JavaScript modules and (TypeScript modules in 
**ts-node**), By setting a custom loader, a ModuleProxy instance can resolve any
kind of module wanted. (NOTE: The loader must provide cache support.)

- `extension` Extension name of the module file, by default, it's `.js` (or `.ts`
    in ts-node).
- `load(filename: string): any` Loads module from the given file or cache.
- `unload(filename: string): void` Unloads the module in cache if the file is 
    modified.

```typescript
// Add a loader to resolve JSON modules.
var json = new alar.ModuleProxy("json", __dirname + "/json");
var cache = {};

json.setLoader({
    extension: ".json",
    load(path) {
        return cache[path] || (
            cache[path] = JSON.parse(fs.readFileSync(path + this.extension, "utf8"))
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
    [x: string]: any,
    host?: string;
    port?: number;
    path?: string;
    secret?: string;
    timeout?: number;
    pingTimeout?: number;
}
```

If `path` is provided (equivalent to `ModuleProxy.serve(config: string)` and 
`ModuleProxy.connect(config: string)`), the RPC channel will be bound to an IPC 
channel. Otherwise, the RPC channel will be bound a network channel according to
the `host` and `port`.

By default `timeout` is set `5000`ms. On the client, it works both in connection
and IPC requests. The client provides internal support of re-connection, if a
remote service is disconnected e.g. the server shutdown (even manually), the 
traffic will be redirected to other online services, and the client will try to
reconnect repeatedly in the background (according to `timeout`).

On the server, the `timeout` is used to set the interval timer of garbage 
collection. Every time the garbage collector runs, it will check if there are
any long-time inactive connections, if a connection is inactive longer than 
`pingTimeout`, then it'll be recycled, and any suspended tasks bound to the
connection will be canceled as well.

The client also uses `pingTimeout` to set the interval timer of ping 
function, once a PING signal is sent, the server will return a PONG signal and
refresh the last active time of the connection (any operation will do that too).
However if the server failed to response a PONG after `timeout`, the client will
think the server is down or something is wrong with the connection, and it will
destroy the current connection immediately in order to create a new one.

# RpcChannel

```typescript
abstract class RpcChannel implements RpcOptions { }
```

This abstract class just indicates the RPC channel that allows modules to 
communicate remotely. `ModuleProxy.serve()` and `ModuleProxy.connect()` return 
its server and client implementations.

The following properties and methods work in both implementations:

- `dsn: string` Gets the data source name according to the configuration.
- `open(): Promise<this>` Opens the channel. This method is internally called by
    `ModuleProxy.serve()` and `ModuleProxy.connect()`, you don't have to call it.
- `close(): Promise<this>` Closes the channel.
- `register<T>(mod: ModuleProxy<T>): this` Registers a module proxy to the 
    channel.
- `onError(handler: (err: Error) => void)` Binds an error handler invoked 
    whenever an error occurred in asynchronous operations which can't be caught
    during run-time.
- `RpcChannel.registerError(ctor: new (...args: any) => Error)` Registers a new 
    type of error so that the channel can transmit it.

# RpcServer

```typescript
class RpcServer extends RpcChannel { }
```

The server implementation of the RPC channel.

- `publish(event: string, data: any, clients?: string[]): boolean` Publishes 
    data to the corresponding event, if `clients` are provided, the event will 
    only be emitted to them.
- `getClients(): string[]` Returns all IDs of clients that connected to the 
    server.

# ClientOptions

```typescript
interface ClientOptions extends RpcOptions {
    id?: string;
}
```

The `id` is used for the server publishing events to specified clients, if not 
provided, a random string will be generated.

# RpcClient

```typescript
class RpcClient extends RpcChannel implements ClientOptions { }
```

The client implementation of the RPC channel.

- `connecting: boolean` Whether the channel is in connecting state.
- `connected: boolean` Whether the channel is connected.
- `closed: boolean` Whether the channel is closed.
- `pause(): boolean`  Pauses the channel and redirect traffic to other channels.
- `resume(): boolean` Resumes the channel and continue handling traffic.
- `subscribe(event: string, listener: Subscriber): this` Subscribes a listener 
    function to the corresponding event.
- `unsubscribe(event: string, listener?: Subscriber): boolean` Unsubscribes the 
    `listener` or all listeners from the corresponding event.

The `Subscriber` is a type of

```typescript
type Subscriber = (data: any) => void | Promise<void>;
```

All listeners bound to an event will be called sequentially in an `async` 
function scope.

## Pub-Sub Model between the server and clients

When the server calls the `publish` method, any client `subscribe`s to the event
will invokes the bound listeners, this mechanism is usually used for the server
broadcasting data to connected clients.