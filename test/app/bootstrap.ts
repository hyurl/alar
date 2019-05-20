declare global {
    namespace app {
        const bootstrap: ModuleProxy<Bootstrap>;
    }
}

export default class Bootstrap {
    data: string[];

    init() {
        this.data = ["hello", "world"];
    }
}