import MyError from "../../error";
import data from "../../data";

declare global {
    namespace app {
        namespace service {
            const user: ModuleProxy<User, string>;
        }
    }
}

export default class User {
    protected propFn: () => void;

    constructor(public name: string) {
        this.propFn = () => { };
    }

    async init() {
        this.setName("Mr. Handsome");
    }

    async destroy() {
        this.setName("Mr. World");
    }

    setName(name: string) {
        this.name = name;
    }

    getName() {
        return this.name;
    }

    *getFriends(...args: string[]) {
        yield "Mozilla";
        yield "GitHub";
        yield "Linux";
        return args;
    }

    async *repeatAfterMe(): AsyncIterableIterator<string> {
        let value = void 0;
        while (true) {
            value = yield value;
        }
    }

    async userError(): Promise<never> {
        throw new MyError("something went wrong");
    }

    async nonStandardError(): Promise<never> {
        throw "something went wrong";
    }

    async setTime(time: number) {
        data.time = time;
    }

    async setAndGet(data: any) {
        return data;
    }

    static getInstance() {
        return new this("Mr. World");
    }
}