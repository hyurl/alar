class MyError extends Error {
    constructor(message) {
        super(message);
    }

    get name() {
        return this.constructor.name;
    }
}

exports.default = MyError;