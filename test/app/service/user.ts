import MyError from "../../error";
import sleep from "@hyurl/utils/sleep";
import * as fs from "fs-extra";

declare global {
    namespace app {
        namespace service {
            const user: ModuleProxy<typeof User>;
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

    async triggerTimeout() {
        await sleep(1500);
    }

    async setTime(time: number) {
        await fs.writeFile(__dirname + "/.tmp", String(time), "utf8");
    }

    async setAndGet(data: any) {
        return data;
    }

    static getInstance() {
        return new this("Mr. World");
    }
}
