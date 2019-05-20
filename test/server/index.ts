import * as alar from "../../src";
import config from "../app/config";

export const App = global["app"] = new alar.ModuleProxy("app", __dirname + "/../app");

(async () => {
    var server = await App.serve(config);

    server.register(app.service.user);

    app.service.user.instance().setName("Mr. Handsome");

    process.send("ready");
})();