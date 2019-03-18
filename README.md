# Alar

Alar is a light-weight framework that provides applications the ability to 
auto-load and hot-reload modules, and the ability to serve and connect remote 
instances.

## Auto-loading and Hot-reloading

In NodeJS (with CommonJS module solution), `require` and `import` will 
immediately load the corresponding module and make a reference *copy* in the 
current scope. Which means, if the module doesn't finish initiation, e.g. 
circular import, the application may not work  as expected, and if the module 
file is modified, the application won't be able to reload that module without 
restart the program.

Alar, on the other hand, based on namespace and ES6 proxy, it creates a 
weak-reference of the module, and only import the module when needed. And since 
it's weak-referenced, it will not make any copy to the module, and when the 
module file is changed, it can wipe out the memory cache and reload the module 
without any side-effect.

### How to use?

In order to use Alar, one must create a root `ModuleProxy` instance, and assign
it to the global namespace, so other files can directly use it without import 
and share the benefits of declaration merging (in TypeScript, if not using is, 
just ignore any tip and code of declaration merging).

### Example

```typescript
// src/app.ts
import { ModuleProxy } from "alar";

// Expose and merge the app as a namespace under the global namespace.
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
have default export, Alar will try to load the entire exports object instead.)

```typescript
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
// src/service/user.ts
// The namespace must correspond to the filename.
declare global {
    namespace app {
        namespace service {
            const user: ModuleProxy<User>
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

// The instance() method will link to the singleton instance of the module.
app.bootstrap.instance().init();

// The create() method will create a new instance.
var user = app.service.user.create("Mr. Handsome");

console.log(user.getName()); // Mr. Handsome
```

### Prototype Module

Any module that exports an object as default will be considered as a prototype 
module, when calling `create()` of that module, the object will be used as a 
prototype, however when calling `instance()` of that module, the object itself 
will be used as the singleton.

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

Alar allows user to easily serve the module remotely, whether in another 
process or in another machine.

### Example

Say I want to serve the user service in a different process and communicate via
IPC channel, I just have to do this:

```typescript
// src/service/user.ts
declare global {
    namespace app {
        namespace service {
            const user: ModuleProxy<User>
        }
    }
}

export default class User {
    constructor(private name?: string) {}

    // Any method that will potentially be called remotely should be async.
    async getName() {
        return this.name;
    }

    // Static method getInstance() is used to create the singleton instance.
    static getInstance() {
        return new this("Mr. Handsome");
    }
}
```

```typescript
// src/remote-service.ts
import { App } from "./app";

(async () => {
    let service = await App.serve("/tmp/my-app/remote-service.sock");

    service.register(app.service.user);

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

    service.register(app.service.user);

    // Access the instance in local style but actually remote.
    console.log(await app.service.user.instance().getName()); // Mr. Handsome
})();
```

*History version of Alar provides a `remote()` method to access remote ability,*
*however since 3.0, with a little API change, `remote()` has been merged to*
*`instance()` and is deprecated.*

### Hot-reloading in Remote Service

The local watcher may notice the local file has changed and try to reload the 
local module (and the local singleton), however, it will not affect any remote 
instances, that said, the instance served remotely can still be watched and 
reloaded on the remote server individually.

In the above example, since the `remote-service` module imports `app` module as 
well, which starts the watcher, when the `user` module is changed, the 
`remote-service` will reload the module as expected, and the `index` calls it 
remotely will get the new result as expected.

## Generator Support

Since version 3.3.0, Alar supports generators (and async generators) in both
local call and remote call contexts.

```typescript
// src/service/user.ts
declare global {
    namespace app {
        namespace service {
            const user: ModuleProxy<User>
        }
    }
}

export default class User {
    // ...
    async *getFriends() {
        yield "Jane";
        yield "Ben";
        yield "Albert";
        return "We are budies";
    }
}

// index.ts
(async () => {
    // Whther calling the local instance or a remote instance, the following 
    // program produce the same result.

    let generator = app.service.user.instance().getFriends();

    for await (let name of generator) {
        console.log(name);
        // Jane
        // Ben
        // Albert
    }

    // If want to get the returning value, just call await on the generator.
    // NOTE: this syntax only works with Alar framework, don't use it with 
    // general generators.
    console.log(await generator); // We are budies

    // The following usage gets the same result.

    let generator2 = app.service.user.instance().getFriends();
    
    while (true) {
        let { value, done } = await generator2.next();
        
        console.log(value);
        // NOTE: calling next() will return the returning value of the generator
        // as well, so the output would be:
        //
        // Jane
        // Ben
        // Albert
        // We are budies

        if (done) {
            break;
        }
    }
});
```

For more details, please check the [API documentation](./api.md).