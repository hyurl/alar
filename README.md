# Alar (progressing)

Alar is a light-weight framework that provides applications the ability to 
auto-load and hot-reload modules, and the ability to serve and connect remote 
instances.

## Auto-loading and Hot-reloading

In NodeJS (with CommonJS module solution), `require` and `import` will 
immediately load the corresponding module and make a reference *copy* in the 
current scope. Which means, if the module file is modified, the application
won't be able to reload that module without restart the program.

Alar, on the other hand, based on namespace and ES6 proxy, it creates a 
weak-reference of the module, and only import the module when needed, Since 
it's weak-referenced, it will not make any copy to the module, and when the 
module file is changed, it can wipe out the memory cache and reload the module 
without any side-effect.

### How to use?

In order to use alar, one must create a root `ModuleProxy` instance, and assign
it to the global namespace, so other files can directly use it without import 
and share the benefits of declaration merging (in TypeScript, if not using 
TypeScript, just ignore any tip and code of declaration merging).

### Example

```typescript
// src/index.ts
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

In other files, just define and export a `default` class, and merge the type to
the namespace `app`, so that another file can access it directly via namespace.

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
// The namespace must relate to the filename.
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
// src/app.ts
import "./index";

// The instance() method will link to the singleton instance of the module.
app.bootstrap.instance().init();

// The create() method will create a new instance.
var user = app.service.user.create("Mr. Handsome");
console.log(user.getName()); // Mr. Handsome
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
import { App } from "./index";

(async () => {
    let service = await App.serve("/tmp/my-app/remote-service");

    service.register(app.service.user);

    console.log("Service started!");
})();
```

Just try `ts-node src/remote-service` (or `node dist/remote-service`), and the
service will be started immediately.

And in app.ts, connect to the service before using remote functions:

```typescript
// app.ts
import { App } from "./index";

(async () => {
    let service = await App.connect("/tmp/my-app/remote-service");

    service.register(app.service.user);

    console.log(await app.service.user.remote().getName()); // Mr. Handsome
})();
```

### Hot-reloading in Remote Service

The local watcher may notice the local file has changed and try to reload the 
local module (and the local singleton), however, it will not affect any remote 
instances, that said, the instance served remotely can still be watched and 
reloaded on the remote server individually.

In the above example, since the `remote-service` module import `index` module as
well, which starts the watcher, when the `user` module is changed, the 
`remote-service` will reload the module as expected, and the `app` calls it 
remotely will get the new result as expected.

For more details, please check the [API documentation](./api.md).