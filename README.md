# Alar

Alar is a light-weight framework that provides applications the ability to 
auto-load and hot-reload modules, as well as the ability to serve instances
remotely as RPC services.

*NOTE: Alar is primarily designed for [SFN](https://github.com/hyurl/sfn)*
*framework.*

## Prerequisites

- Node.js `v8.3.0+`

## Auto-loading and Hot-reloading

In NodeJS (with CommonJS module solution), `require` and `import` will
immediately load the corresponding module and make a reference in the current
scope. That means, if the module doesn't finish initiation, e.g. circular
import, the application may not work as expected. And if the module file is
modified, the application won't be able to reload that module without
restarting the program.

Alar, on the other hand, based on the namespace and ES6 proxy, it creates a 
*"soft-link"* of the module, and only import the module when truly needed. And
since it's soft-linked, when the module file is changed, it has the ability to
wipe out the memory cache and reload the module with very few side-effects.

### How to use?

In order to use Alar, one must create a root `ModuleProxy` instance and assign
it to the global scope, so other files can directly use it as a root namespace
without importing the module.

**NOTE: Since v5.5, Alar introduced two new syntaxes to get the singleton and**
**create new instances of the module, they are more light-weight and elegant,**
**so this document will in favor of them, although the old style still works.**

### Example

```typescript
// src/app.ts
import { ModuleProxy } from "alar";

// Expose and merge the app as a namespace under the global scope.
declare global {
    namespace app { }
}

// Create the instance.
export const App = global["app"] = new ModuleProxy("app", __dirname);

// Watch file changes and hot-reload modules.
App.watch();
```

In other files, just define and export a default class, and merge the type to 
the namespace `app`, so that another file can access it directly via namespace.

(NOTE: Alar offers first priority of the `default` export, if a module doesn't 
have a default export, Alar will try to load all exports instead.)

```typescript
// Be aware that the namespace must correspond to the filename.

// src/bootstrap.ts
declare global {
    namespace app {
        const bootstrap: ModuleProxy<Bootstrap>
    }
}

export default class Bootstrap {
    init() {
        // ...
    }
}
```

```typescript
// src/models/user.ts
declare global {
    namespace app {
        namespace models {
            // Since v5.0, a module class with parameters must use the signature
            // `typeof T`.
            const user: ModuleProxy<typeof User>
        }
    }
}

export default class User {
    constructor(private name: string) { }

    getName() {
        return this.name;
    }
}
```

And other files can access to the modules via the namespace:

```typescript
// src/index.ts
import "./app";

// Calling the module as a function will link to the singleton of the module.
app.bootstrap().init();

// Using `new` syntax on the module to create a new instance.
var user = new app.models.user("Mr. Handsome");

console.log(user.getName()); // Mr. Handsome
```

### Prototype Module

Any module that exports an object as default will be considered as a prototype 
module, when creating a new instance of that module, the object will be used as
a prototype (since v4.0.4, a deep clone will be used instead, if an argument is
passed, it will be merged into the new object). However when calling the
singleton of that module, the original object itself will be returned.

```typescript
// src/config.ts
declare global {
    namespace app {
        const config: ModuleProxy<Config>;
    }
}

export interface Config {
    // ...
}

export default <Config>{
    // ...
}
```

## Remote Service

Alar allows user to easily serve a module remotely, whether in another
process or in another machine.

### Example

Say I want to serve a user service in a different process and communicate via
IPC channel, I just have to do this:

```typescript
// src/services/user.ts
declare global {
    namespace app {
        namespace services {
            const user: ModuleProxy<typeof UserService>
        }
    }
}

// It is recommended not to define the constructor and use a non-parameter
// constructor.
export default class UserService {
    private users: { firstName: string, lastName: string }[] = [
        { firstName: "David", lastName: "Wood" },
        // ...
    ];

    // Any method that will potentially be called remotely should be async.
    async getFullName(firstName: string) {
        let user = this.users.find(user => {
            return user.firstName === firstName;
        });

        return user ? `${firstName} ${user.lastName}` : void 0;
    }
}
```

```typescript
// src/remote-service.ts
import { App } from "./app";

(async () => {
    let service = await App.serve("/tmp/my-app/remote-service.sock");

    service.register(app.services.user);

    console.log("Service started!");
})();
```

Just try `ts-node --files src/remote-service` (or `node dist/remote-service`), 
and the service will be started immediately.

And in **index.ts**, connect to the service before using remote functions:

```typescript
// index.ts
import { App } from "./app";

(async () => {
    let service = await App.connect("/tmp/my-app/remote-service.sock");

    service.register(app.services.user);

    // Accessing the instance in local style but actually calling remote.
    // Since v6.0, the **route** argument for the module must be explicit.
    let fullName = await app.services.user("route").getFullName("David");
    console.log(fullName); // David Wood
})();
```

### Hot-reloading in Remote Service

The local watcher may notice the local file has been changed and try to reload
the local module (and the local singleton), however, it will not affect any
remote instances, that said, the instance served remotely can still be watched
and reloaded on the remote server individually.

In the above example, since the **remote-service.ts** module imports **app.ts**
module as well, which starts the watcher, when the **user.ts** module is changed,
the **remote-service.ts** will reload the module as expected, and the
**index.ts** calls it remotely will get the new result as expected.

## Generator Support

Since version 3.3, Alar supports generators (and async generators) in both local
call and remote call contexts.

```typescript
// src/services/user.ts
declare global {
    namespace app {
        namespace services {
            const user: ModuleProxy<UserService>
        }
    }
}

export default class UserService {
    // ...
    async *getFriends() {
        yield "Jane";
        yield "Ben";
        yield "Albert";
        return "We are buddies";
    }
}

// index.ts
(async () => {
    // Whether calling the local instance or a remote instance, the following 
    // program produces the same result.

    let generator = app.services.user("route").getFriends();

    for await (let name of generator) {
        console.log(name);
        // Jane
        // Ben
        // Albert
    }

    // The following usage gets the same result.
    let generator2 = app.services.user("route").getFriends();

    while (true) {
        let { value, done } = await generator2.next();

        console.log(value);
        // NOTE: calling next() will return the returning value of the generator
        // as well, so the output would be:
        //
        // Jane
        // Ben
        // Albert
        // We are buddies

        if (done) {
            break;
        }
    }
})();
```

## Life Cycle Support

Since v6.0, Alar provides a new way to support life cycle functions, it will be
used to perform asynchronous initiation, for example, connecting to a database.
And if it contains a `destroy()` method, it will be used to perform asynchronous
destruction, to release resources.

To enable this feature, first calling `ModuleProxy.serve()` method to create an
RPC server that is not yet served immediately by passing the second argument
`false`, and after all preparations are finished, calling the `RpcServer.open()`
method to open the channel and initiate bound modules.

This feature will still work after hot-reloaded the module. However, there
would be a slight downtime during hot-reloading, and any call would fail until
the service is re-available again.

NOTE: Life cycle functions are only triggered when serving the module as an RPC
service, and they will not be triggered for local backups. That means, allowing
to fall back to local instance may cause some problems, since they haven't
performed any initiations. To prevent expected behavior, it would better to
disable the local version of the service by calling `fallbackToLocal(false)`.

```ts
// src/services/user.ts
declare global {
    namespace app {
        namespace services {
            const user: ModuleProxy<UserService>
        }
    }
}

export default class UserService {
    async init() {
        // ...
    }

    async destroy() {
        // ...
    }
}


(async () => {
    let service = App.serve(config, false); // pass false to serve()

    service.register(app.services.user);

    // other preparations...

    await service.open();
})();
```

For more details, please check the [API documentation](./api.md).
