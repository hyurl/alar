"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
class Member {
    constructor(name) {
        this.name = name;
    }
    getName() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            return this.name;
        });
    }
    static foo() {
    }
    static getInstance() {
        return new this("Ayon Lee");
    }
}
exports.default = Member;
//# sourceMappingURL=member.js.map