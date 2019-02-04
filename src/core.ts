import { ModuleProxy } from ".";

declare global {
    namespace app { }
}

const app = global["app"] = new ModuleProxy("app", __dirname);

app.watch();