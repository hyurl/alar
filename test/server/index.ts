import * as alar from "../../src";
import config from "../app/config";
import define from "@hyurl/utils/define";
import "../error";

export const App = new alar.ModuleProxy("app", __dirname + "/../app");

define(global, "app", App);

(async () => {
    var server: alar.RpcServer;

    if (process.env["USE_IPC"]) {
        server = await App.serve(<string>process.env["USE_IPC"]);
    } else if (process.env["USE_SECRET"]) {
        server = await App.serve({ ...config, secret: process.env["USE_SECRET"] });
    } else if (process.env["USE_CODEC"]) {
        server = await App.serve({ ...config, codec: <any>process.env["USE_CODEC"] });
    } else {
        server = await App.serve(config);
    }

    server.register(app.service.user);

    process.send("ready");

    process.on("message", async (msg) => {
        if (msg === "exit") {
            await server.close();
            process.send("exited");
        }
    });
})();
