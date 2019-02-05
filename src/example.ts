import { App } from "./core";
import sleep = require("sleep-promise");

(async () => {
    await sleep(1000);

    var service = await App.connect("separ.sock");

    service.register(app.user.member);
    service.register(app.user.vip);

    var name = await app.user.member.remote().getName();

    console.log(name);
})();