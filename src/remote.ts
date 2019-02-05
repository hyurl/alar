import { App } from "./core";

(async () => {
    const service = await App.serve("separ.sock");

    service.register(app.user.vip);
    service.register(app.user.member);
})();