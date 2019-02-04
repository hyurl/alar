import Member from "./member";

declare global {
    namespace app {
        namespace user {
            const vip: ModuleProxy<Vip, string>;
        }
    }
}



export default class Vip extends (<typeof Member>app.user.member.ctor) {
    getMyName() {
        return this.name;
    }
}