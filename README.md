# Separ

Separ is a light-weight framework that provides applications the ability to 
lazy-load and hot-reload modules, and the ability to connect remote instances.

## Lazy-load and Hot-reload

In NodeJS (with CommonJS module resolution), `require` and `import` will 
immediately load the corresponding module and make a reference *copy* in the 
current scope. Which means, if the module file is modified, the application
won't be able to reload that module without restart the program.

Separ, on the other hand, based on namespace and ES6 proxy, it creates a 
weak-reference of the module, and only import the module when needed, Since 
it's weak-referenced, it will not make any copy to the module, and when the 
module file is changed, it can wipe out the memory cache and reload the module 
without any side-effect.

### How to use?

In order to use Separ, one must create a root `ModuleProxy` instance, and assign
it to the global namespace, so other files can directly use it without import 
and share the benefits of declaration merging (in TypeScript, if not using 
TypeScript, just ignore any tip and code of declaration merging).

### Example

```typescript
// src/index.ts
import { ModuleProxy } from "separ";

// expose and merge the app as a namespace under the global namespace
declare global {
    namespace app { }
}

// create the instance
const app = global["app"] = new ModuleProxy("app", __dirname);

// watch file changes and hot-reload modules
app.watch();
```

In other files, just define and export a `default` class, and merge the type to
the namespace `app`, so that another file can access it directly via namespace.

```typescript
// src/boostrap.ts
declare global {
    namespace app {
        const boostrap: ModuleProxy<Boostrap>
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
// the namespace must corresponds to the filename.
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

// the instance() method will link to the singleton instance of the module.
app.boostrap.instance().init();

// the create() method will create a new instance.
var user = app.service.user.create("Mr. Handsome");
console.log(user.getName()); // Mr. Handsome
```

## Remote Instance

Separ allows user to easily serve the module remotely, whether in another 
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
    /** A unqiue ID just for the applcation to find the remote service */
    static id = "app.serivce.user";

    constructor(private name: string) { }

    // any method that will potentially be called remotely should be async.
    async getName() {
        return this.name;
    }
}
```

```typescript
// src/remote-service.ts
import "./index";

(async () => {
    await app.service.user.serve("/tmp/my-app/remote-service");

    console.log("Service started!");
})();
```

Just try `ts-node remote-service`, and the service will be started immediately.

And in app.ts, connect to the service before using remote functions:

```typescript
// app.ts
import "./index";

(async () => {
    await app.service.user.connect("/tmp/my-app/remote-service");

    console.log(await app.service.user.remote().getName()); // Mr. Handsome
});
```

### Hot-reload in Remote Service

The local watcher may notice the local file has changed and try to reload the 
local module (and local singletons), however, it will not affect any remote 
instances, that said, the instanced served remotely can still be watched and 
reload on the remote server individually.

In the above example, since the `remote-service` module import `index` module as
well, which starts the watcher, when the `user` module is changed, the 
`remote-service` will reload the module as expected, and the `app` calls it 
remotely will get the expected result as well.