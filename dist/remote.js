"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const core_1 = require("./core");
(() => tslib_1.__awaiter(this, void 0, void 0, function* () {
    const service = yield core_1.App.serve("separ.sock");
    service.register(app.user.vip);
    service.register(app.user.member);
}))();
//# sourceMappingURL=remote.js.map