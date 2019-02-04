declare global {
    namespace app {
        namespace user {
            const member: ModuleProxy<Member, string>;
        }
    }
}

export default class Member {
    protected name: string;

    constructor(name: string) {
        this.name = name;
    }

    async getName(): Promise<string> {
        return this.name;
    }

    static foo() {

    }

    static getInstance() {
        return new this("Ayon Lee");
    }
}