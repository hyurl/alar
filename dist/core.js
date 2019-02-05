"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const index_1 = require("./index");
exports.App = global["app"] = new index_1.ModuleProxy("app", __dirname);
exports.App.watch();
//# sourceMappingURL=core.js.map