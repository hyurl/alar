const MyError = require("../../error").default;

exports.default = class User {
    constructor(name) {
        this.name = name;
    }

    setName(name) {
        this.name = name;
    }

    getName() {
        return this.name;
    }

    *getFriends(...args) {
        yield "Mozilla";
        yield "GitHub";
        yield "Linux";
        return args;
    }

    *repeatAfterMe() {
        let value = void 0;
        while (true) {
            value = yield value;
        }
    }

    userError() {
        throw new MyError("something went wrong");
    }

    nonStandardError() {
        throw "something went wrong";
    }

    static getInstance() {
        return new this("Mr. World");
    }
};