"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const core_1 = require("./core");
const sleep = require("sleep-promise");
(() => tslib_1.__awaiter(this, void 0, void 0, function* () {
    yield sleep(1000);
    var service = yield core_1.App.connect("separ.sock");
    service.register(app.user.member);
    service.register(app.user.vip);
    var name = yield app.user.member.remote().getName();
    console.log(name);
}))();
//# sourceMappingURL=example.js.map