# API Reference

## ModuleProxy

```typescript
interface ModuleProxy<T> {}
```

Once Alar is imported to the project, this interface will be presented under 
the global scope, and can be used everywhere.

The interface has the following properties and methods (deprecated items are not
listed):

- `name: string` The name (with namespace) of the module.
- `path: string` The path (without extension) of the module.
- `exports: any` The very exports object of the module.
- `proto: T` The very prototype of the module.
- `ctor: typeof T extends Function ? T : new (...args: any[]) => T` The very
    class constructor of the module.
- `create(...args: any[]): T` Creates a new instance of the module.
- `instance(route?: any): T` Gets the local singleton or a remote instance of 
    the module, if connected to one or more remote instances, the module proxy 
    will automatically calculate the `route` and direct the traffic to the 
    corresponding remote instance. If the given route matches the server ID of 
    any remote service, the corresponding instance will be returned instead.
- `fallbackToLocal(enable: boolean): this` If the module is registered as a
    remote service, however none of the RPC channel is available, allow calls to
    fallback to the local instance, which is the default behavior, this method
    is used to disable (pass `false`) and re-enable (pass `true`) this behavior.

**NOTE: RPC calling will serialize all input and output data, those data that**
**cannot be serialized will be lost during transmission.**

**NOTE: properties cannot be accessed remotely, if trying so, `null` or**
**`undefined` will be returned instead, so it's better to declare properties**
**`protected` or `private` in any service class that may potentially served**
**remotely.**

**CHANGE: Since v5.0, every method called from `instance()` is wrapped**
**asynchronous, regardless of local call or remote call.**

**CHANGE: Since v5.0, a module class with parameters must use the signature**
**`ModuleProxy<typeof T>` in order to provide correct type hint for**
**`create()` function.**

**CHANGE: Since v5.4, the module now can be called as a function, and**
**it acts just the same as calling `instance()` function.**

**CHANGE: Since v5.5, the module now can be called as a class constructor,**
**and it acts just the same as calling `create()` function.**

**CHANGE: Since v6.0 `noLocal()` method has be deprecated in favor of**
**`fallbackToLocal(false)`.**

**CHANGE: v6.0 fix the forced asynchronous behavior added in v5.0, now only**
**remote calls and the calls fell back to local are forced asynchronous.**

# ModuleProxy (class)

```typescript
class ModuleProxy {
    constructor(name: string, path: string, loader?: ModuleLoader);
}
```

This class must be imported in order to create a root module proxy, and the root
module should be declared as a namespace under the global scope, in TypeScript,
the following steps must be walked though for Alar to work in a project.

```typescript
import { ModuleProxy } from "alar";

// This statement creates a root module and assign it to the global scope in 
// NodeJS.
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

**CHANGE: Since v5.4, class `ModuleProxy` now takes a third optional parameter**
**to set the loader when instantiating.**

## ModuleLoader

```typescript
export interface ModuleLoader {
    extension: string | string[],
    load(filename: string): any;
    unload(filename: string): void;
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
const json = new alar.ModuleProxy("json", __dirname + "/json");

json.setLoader({
    cache: {},
    extension: ".json",
    load(filename) {
        return this.cache[filename] || (
            this.cache[filename] = JSON.parse(fs.readFileSync(filename, "utf8"))
        );
    },
    unload(filename) {
        delete this.cache[filename];
    }
});
```

## createModuleProxy

```ts
export function createModuleProxy(
    name: string,
    path: string,
    loader?: ModuleLoader,
    singletons?: { [name: string]: any }
): ModuleProxy
```

Creates a module proxy manually. This function is used under the hood of Alar
framework, however, if you want to create a module proxy outside the root proxy,
you can use this function to do so.

## RpcOptions

```typescript
interface RpcOptions {
    [x: string]: any,
    host?: string;
    port?: number;
    path?: string;
    secret?: string;
    id?: string;
    codec?: "CLONE" | "JSON" | "BSON" | "FRON"
}
```

If `path` is provided (equivalent to `ModuleProxy.serve(config: string)` and 
`ModuleProxy.connect(config: string)`), the RPC channel will be bound to an IPC 
channel. Otherwise, the RPC channel will be bound to a network channel according
to the `host` and `port`.

`secret` is used as a password for authentication, if used, the client must
provide it as well in order to grant permission to connect.

The `id` property is a little ambiguous. On the server side, if omitted, it will
fall back to `dsn`, used for the client routing requests. On the client side, if
omitted, a random string will be generated, used for the server publishing
topics.

The `codec` property sets in what format should the data be transferred. Since
v5.2, Alar uses a new codec `CLONE` by default, it's based on `JSON` however
with structured clone of the original data, that means it supports more types
than JSON do, like Date, RegExp, TypedArray etc. For more information, see
[@hyurl/structured-clone](https://github.com/hyurl/structured-clone).

If set `BSON` or `FRON`, the following corresponding packages must be installed.

- BSON: [bson](https://github.com/mongodb/js-bson)
    or [bson-ext](https://github.com/mongodb-js/bson-ext);
- FRON: [fron](https://github.com/hyurl/fron)

## RpcChannel

```typescript
abstract class RpcChannel implements RpcOptions { }
```

This abstract class just indicates the RPC channel that allows modules to 
communicate remotely. methods `ModuleProxy.serve()` and `ModuleProxy.connect()`
return its server and client implementations accordingly.

The following properties and methods work in both implementations:

- `id: string` The unique ID of the server or the client.
- `dsn: string` Gets the data source name according to the configuration.
- `open(): Promise<this>` Opens the channel. This method is internally called by
    `ModuleProxy.serve()` and `ModuleProxy.connect()`, normally, you don't have
    to call it explicitly.
- `close(): Promise<this>` Closes the channel.
- `register<T>(mod: ModuleProxy<T>): this` Registers a module to the channel.
- `onError(handler: (err: Error) => void)` Binds an error handler invoked 
    whenever an error occurred in asynchronous operations which can't be caught
    during run-time.

## RpcServer

```typescript
class RpcServer extends RpcChannel { }
```

The server implementation of the RPC channel.

- `init(): Promise<void>` Performs initiation processes for registered modules.
- `publish(topic: string, data: any, clients?: string[]): boolean` Publishes 
    data to the corresponding topic, if `clients` are provided, the topic will 
    only be published to them.
- `getClients(): string[]` Returns all IDs of clients that connected to the 
    server.

## ClientOptions

```typescript
interface ClientOptions extends RpcOptions {
    timeout?: number;
    pingInterval?: number;
}
```

By default `timeout` is set `5000`ms, it is used to force a timeout error when
a RPC request fires and doesn't get response after a long time.

The client uses `pingInterval` to set a timer of ping function, so that to
ensure the connection is alive. If the server doesn't response when pinging, the
client will consider the server is down and will destroy and retry the
connection.

### About Reconnection

When the client detects the server is down or malfunction, it will destroy the
connection positively and retry connect. Since v5.4, this feature uses an
exponential back-off mechanism to retry connect rapidly util about 30 minutes
timeout before consider the server is down permanently, and will close the
channel after that.

**NOTE: prior to v5.4, reconnection tries timeout is 2 minutes.**

## RpcClient

```typescript
class RpcClient extends RpcChannel implements ClientOptions { }
```

The client implementation of the RPC channel.

- `connecting: boolean` Whether the channel is in connecting state.
- `connected: boolean` Whether the channel is connected.
- `closed: boolean` Whether the channel is closed.
- `pause(): boolean`  Pauses the channel and redirect traffic to other channels.
- `resume(): boolean` Resumes the channel and continue handling traffic.
- `subscribe(topic: string, handle: Subscriber): this` Subscribes a handle
    function to the corresponding topic.
- `unsubscribe(topic: string, handle?: Subscriber): boolean` Unsubscribes the
    handle function or all handlers from the corresponding topic.

The `Subscriber` is a type of

```typescript
type Subscriber = (data: any) => void | Promise<void>;
```

## Pub-Sub Model between the server and clients

When the server publishes a message, all clients subscribe to the topic
will receive the data and invoke their handlers, this mechanism is often used
for the server to broadcast data to its clients.
