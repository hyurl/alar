const MyError = require("../../error").default;
const data = require("../../data").default;

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

    setTime(time) {
        data.time = time;
    }

    setAndGet(data) {
        return data;
    }

    static getInstance() {
        return new this("Mr. World");
    }
};