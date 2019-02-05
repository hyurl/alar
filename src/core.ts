import "source-map-support/register";
import { ModuleProxy } from "./index";

declare global {
    namespace app { }
}

export const App = global["app"] = new ModuleProxy("app", __dirname);

App.watch();