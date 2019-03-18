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

    static getInstance() {
        return new this("Mr. World");
    }
};