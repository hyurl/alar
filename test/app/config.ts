declare global {
    namespace app {
        const config: ModuleProxy<{
            host: string;
            port: number;
            timeout: number;
        }>;
    }
}

export default {
    host: "127.0.0.1",
    port: 18888,
    timeout: 1000
}