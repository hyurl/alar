"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
require("./core");
(() => tslib_1.__awaiter(this, void 0, void 0, function* () {
    console.log(app.user.vip.instance().getMyName());
    var name = yield app.user.member.instance().getName();
    console.log(name);
}))();
//# sourceMappingURL=example.js.map