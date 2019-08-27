import "source-map-support/register";
import * as alar from "../src";
import * as assert from "assert";
import * as path from "path";
import * as fs from "fs-extra";
import * as sleep from "sleep-promise";
import Bootstrap from "./app/bootstrap";
import User from "./app/service/user";
import config from "./app/config";
import * as childProcess from "child_process";
import * as net from "net";
import MyError from "./error";
import data from "./data";

var App: alar.ModuleProxy;

function fork(filename: string): Promise<childProcess.ChildProcess> {
    return new Promise((resolve, reject) => {
        let proc = childProcess.fork(filename);

        proc.on("error", reject).on("message", msg => {
            if (msg === "ready") {
                resolve(proc);
            }
        });
    });
}

describe("Alar ModuleProxy", () => {
    it("should create a root module proxy instance as expected", () => {
        App = global["app"] = new alar.ModuleProxy("app", __dirname + "/app");
        assert.strictEqual(App.name, "app");
        assert.strictEqual(App.path, path.normalize(__dirname + "/app"));
    });

    it("should access to a module as expected", () => {
        assert.strictEqual(app.bootstrap.name, "app.bootstrap");
        assert.strictEqual(app.bootstrap.path, path.normalize(__dirname + "/app/bootstrap"));
        assert.strictEqual(app.bootstrap.ctor, Bootstrap);
    });

    it("should access to a deep module as expected", () => {
        assert.strictEqual(app.service.user.name, "app.service.user");
        assert.strictEqual(app.service.user.path, path.normalize(__dirname + "/app/service/user"));
        assert.strictEqual(app.service.user.ctor, User);
    });

    it("should resolve module name according to the given path as expected", () => {
        assert.strictEqual(App.resolve(app.service.user.path), "app.service.user");
        assert.strictEqual(App.resolve(app.service.user.path + ".js"), "app.service.user");
    });

    it("should create instances via create() method as expected", async () => {
        let user1 = app.service.user.create("Mr. Handsome");
        let user2 = app.service.user.create("Mr. World");

        assert.ok(user1 instanceof User);
        assert.ok(user2 instanceof User);
        assert.strictEqual(user1.name, "Mr. Handsome");
        assert.strictEqual(user2.name, "Mr. World");
        assert.strictEqual(await user1.getName(), user1.name);
        assert.strictEqual(await user2.getName(), user2.name);
    });

    it("should create instance via ctor property as expected", () => {
        let bootstrap = new app.bootstrap.ctor();

        bootstrap.init();
        assert.ok(bootstrap instanceof Bootstrap);
        assert.deepStrictEqual(bootstrap.data, ["hello", "world"]);
    });

    it("should get singleton instance via instance() method as expected", () => {
        app.service.user.instance(alar.util.local).name = "Mr. Handsome";
        assert.ok(app.service.user.instance() instanceof User);
        assert.strictEqual(app.service.user.instance().name, "Mr. Handsome");
        app.service.user.instance(alar.util.local).name = "Mr. World";
        assert.strictEqual(app.service.user.instance().name, "Mr. World");
    });

    it("should access to a prototype module as expected", () => {
        assert.strictEqual(app.config.name, "app.config");
        assert.strictEqual(app.config.path, path.normalize(__dirname + "/app/config"));
        assert.deepStrictEqual(app.config.proto, config);
    });

    it("should create instance from a prototype module as expected", () => {
        let ins = app.config.create();
        assert.deepStrictEqual(ins, config);

        let ins2 = app.config.create({ host: "localhost" });
        assert.deepStrictEqual(ins2, { ...config, host: "localhost" });
    });

    it("should use the prototype module as singleton as expected", () => {
        let ins = app.config.instance();
        assert.deepStrictEqual(ins, config);
    });

    it("should use a custom loader to load JSON module as expected", () => {
        let Json = new alar.ModuleProxy("json", __dirname + "/json");
        let cache = {};
        let json: any = Json;

        Json.setLoader({
            extension: ".json",
            load(filename) {
                return cache[filename] || (
                    cache[filename] = JSON.parse(fs.readFileSync(filename, "utf8"))
                );
            },
            unload(filename) {
                cache[filename] && (delete cache[filename]);
            }
        });

        assert.deepStrictEqual(json.test.instance(), { name: "JSON", version: "1.0.0" });
    });

    it("should use a custom loader with multiple extensions as expected", () => {
        let Json = new alar.ModuleProxy("json", __dirname + "/json");
        let json: any = Json;
        let expected = {
            foo: "Hello",
            bar: "World"
        };

        Json.setLoader({
            cache: {},
            extension: [".js", ".json"],
            load(filename) {
                let ext = path.extname(filename);

                if (ext === ".js") {
                    return require(filename);
                } else if (this.cache[filename]) {
                    return this.cache[filename];
                } else { // .json
                    let content = fs.readFileSync(filename, "utf8");
                    let result = JSON.parse(content);
                    return (this.cache[filename] = result);
                }
            },
            unload(filename) {
                delete this.cache[filename];
            }
        });

        assert.deepStrictEqual(json.test1.instance(), expected);
        assert.deepStrictEqual(json.test2.instance(), expected);
        assert.strictEqual(Json.resolve(__dirname + "/json/test1.js"), "json.test1");
        assert.strictEqual(Json.resolve(__dirname + "/json/test2.json"), "json.test2")
    });

    it("should serve an IPC service as expected", async () => {
        let sockPath = process.cwd() + "/alar.sock";
        let server = await App.serve(sockPath);

        server.register(app.service.user);

        let client = await App.connect(sockPath);

        client.register(app.service.user);

        assert.strictEqual(await app.service.user.instance().getName(), "Mr. World");

        await client.close();
        await server.close();
    });

    it("should serve an RPC service as expected", async () => {
        let server = await App.serve(config);

        server.register(app.service.user);

        let client = await App.connect(config);

        client.register(app.service.user);

        assert.strictEqual(await app.service.user.instance().getName(), "Mr. World");

        await client.close();
        await server.close();
    });

    it("should serve an RPC service with secret as expected", async () => {
        let _config = Object.assign({ secret: "abcdefg" }, config);
        let server = await App.serve(_config);

        server.register(app.service.user);

        let client = await App.connect(_config);

        client.register(app.service.user);

        assert.strictEqual(await app.service.user.instance().getName(), "Mr. World");

        await client.close();
        await server.close();
    });

    it("should get clients connected to the service in IDs as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        assert.deepStrictEqual(server.getClients(), [client.id]);

        await client.close();
        await server.close();
    });

    it("should pause and resume remote service as expected as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);

        assert.ok(app.service.user.instance() !== app.service.user.instance(App.local));

        client.pause();

        assert.ok(app.service.user.instance() === app.service.user.instance(App.local));

        client.resume();

        assert.ok(app.service.user.instance() !== app.service.user.instance(App.local));

        await client.close();
        await server.close();
    });

    it("should refuse connect if secret is incorrect as expected", async () => {
        let _config = Object.assign({ secret: "abcdefg" }, config);
        let server = await App.serve(_config);
        let socket = net.createConnection(config.port, config.host);
        socket.write("12345");

        while (!socket.destroyed) {
            await sleep(10);
        }

        assert.ok(socket.destroyed);

        await server.close();
    });

    it("should reconnect the RPC service in the background automatically", async () => {
        let filename = __dirname + "/server/index.js";
        let proc = await fork(filename);
        let client = await App.connect(config);

        client.register(app.service.user);

        // kill the server and restart it, the client will reconnect in the
        // background automatically.
        proc.kill();
        proc = await fork(filename);

        while (!client.connected) {
            await sleep(100);
        }

        assert.strictEqual(await app.service.user.instance().getName(), "Mr. Handsome");

        await client.close();
        proc.kill();
        await sleep(100);
    });

    it("should reject error is no remote service is available", async () => {
        let err: ReferenceError;

        try {
            app.service.user.noLocal();
            await app.service.user.instance().getName();
        } catch (e) {
            err = e;
        }

        assert.ok(err instanceof ReferenceError);
    });

    it("should subscribe and publish an event as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);
        let data;

        client.subscribe("set-data", msg => {
            data = msg;
        });

        server.publish("set-data", "Mr. World");

        while (!data) {
            await sleep(50);
        }

        assert.strictEqual(data, "Mr. World");

        await client.close();
        await server.close();
    });

    it("should subscribe and publish multiple events as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);
        let data;
        let data1;
        let data2;

        client.subscribe("set-data", msg => {
            data = msg;
        }).subscribe("set-data", msg => {
            data1 = msg;
        }).subscribe("set-data-2", msg => {
            data2 = msg;
        });

        server.publish("set-data", "Mr. World");
        server.publish("set-data-2", "Mr. World");

        while (!data || !data1 || !data2) {
            await sleep(50);
        }

        assert.strictEqual(data, "Mr. World");
        assert.strictEqual(data1, "Mr. World");
        assert.strictEqual(data2, "Mr. World");

        await client.close();
        await server.close();
    });

    it("should unsubscribe event handles as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);
        let listner = () => null;
        let listner2 = () => null;

        client.subscribe("set-data", listner)
            .subscribe("set-data", listner2)
            .subscribe("set-data-2", listner)
            .subscribe("set-data-2", listner2)

        client.unsubscribe("set-data", listner);
        client.unsubscribe("set-data-2");

        assert.deepStrictEqual(client["events"], {
            "set-data": [listner2]
        });

        await client.close();
        await server.close();
    });

    it("should publish an event to specified clients as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(Object.assign({}, config, { id: "abc" }));
        let data;

        assert.strictEqual(client.id, "abc");

        client.subscribe("set-data", msg => {
            data = msg;
        });

        server.publish("set-data", "Mr. World", ["abc"]);

        while (!data) {
            await sleep(50);
        }

        assert.strictEqual(data, "Mr. World");

        await client.close();
        await server.close();
    });

    it("should get result from a remote generator as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);
        let result: (string | string[])[] = [];

        server.register(app.service.user);
        client.register(app.service.user);

        let generator = app.service.user.instance().getFriends("Open Source", "Good Fella");
        while (true) {
            let res = await generator.next();

            result.push(res.value);

            if (res.done) {
                break;
            }
        }

        assert.deepStrictEqual(result, ["Mozilla", "GitHub", "Linux", ["Open Source", "Good Fella"]]);

        await client.close();
        await server.close();
    });

    it("should invoke next method in the remote generator as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);

        let generator = app.service.user.instance().repeatAfterMe();
        let result = await generator.next("Google");
        let result1 = await generator.next("Google");

        assert.deepStrictEqual(result, { value: undefined, done: false });
        assert.deepStrictEqual(result1, { value: "Google", done: false });

        await client.close();
        await server.close();
    });

    it("should invoke return method in the remote generator as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);

        let generator = app.service.user.instance().repeatAfterMe();
        let result = await generator.return("Google");

        assert.deepStrictEqual(result, { value: "Google", done: true });
        assert.strictEqual(await generator, "Google");

        await client.close();
        await server.close();
    });

    it("should invoke throw method in the remote generator as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);

        let generator = app.service.user.instance().repeatAfterMe();
        let _err = new Error("test throw method");
        let err: Error;

        try {
            await generator.throw(_err);
        } catch (e) {
            err = e;
        }

        assert.ok(err !== _err);
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, "test throw method");
        assert.deepStrictEqual(await generator.next(), { value: undefined, done: true });
        assert.strictEqual(await generator, undefined);

        await client.close();
        await server.close();
    });

    it("should get result from a local generator as expected", async () => {
        let result: (string | string[])[] = [];
        let generator = app.service.user.instance(App.local).getFriends("Open Source", "Good Fella");

        while (true) {
            let res = await generator.next();

            result.push(res.value);

            if (res.done) {
                break;
            }
        }

        assert.deepStrictEqual(result, ["Mozilla", "GitHub", "Linux", ["Open Source", "Good Fella"]]);
    });

    it("should invoke next method in the local generator as expected", async () => {
        let generator = app.service.user.instance(App.local).repeatAfterMe();
        let result = await generator.next("Google");
        let result1 = await generator.next("Google");

        assert.deepStrictEqual(result, { value: undefined, done: false });
        assert.deepStrictEqual(result1, { value: "Google", done: false });
    });

    it("should invoke return method in the local generator as expected", async () => {
        let generator = app.service.user.instance(App.local).repeatAfterMe();
        let result = await generator.return("Google");

        assert.deepStrictEqual(result, { value: "Google", done: true });
        assert.strictEqual(await generator, "Google");
    });

    it("should invoke throw method in the local generator as expected", async () => {
        let generator = app.service.user.instance(App.local).repeatAfterMe();
        let _err = new Error("test throw method");
        let err: Error;

        try {
            await generator.throw(_err);
        } catch (e) {
            err = e;
        }

        assert.ok(err === _err);
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, "test throw method");
        assert.deepStrictEqual(await generator.next(), { value: undefined, done: true });
        assert.strictEqual(await generator, undefined);
    });

    it("should return as-is from a local instance regular method as expected", async () => {
        let data = {};
        let name = await app.service.user.instance(App.local).getName();
        let result = await app.service.user.instance(App.local).setAndGet(data);

        assert.strictEqual(name, "Mr. World");
        assert.strictEqual(result, data);
    });

    it("should transmit a custom error as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);
        alar.RpcChannel.registerError(MyError);

        let err: MyError;

        try {
            await app.service.user.instance().userError();
        } catch (e) {
            err = e;
        }

        assert.ok(err instanceof MyError);
        assert.strictEqual(err.name, "MyError");
        assert.strictEqual(err.message, "something went wrong");
        assert.strictEqual(err.toString(), "MyError: something went wrong");

        await client.close();
        await server.close();
    });

    it("should transmit a non-standard error as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);
        alar.RpcChannel.registerError(MyError);

        let err: string;

        try {
            await app.service.user.instance().nonStandardError();
        } catch (e) {
            err = e;
        }

        assert.strictEqual(err, "something went wrong");

        await client.close();
        await server.close();
    });

    it("should invoke the remote method in the background as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);

        let time = Date.now();

        // DO NOT await
        app.service.user.instance().setTime(time);

        while (!data.time) {
            await sleep(10);
        }

        assert.strictEqual(data.time, time);

        await client.close();
        await server.close();
    });

    it("should invoke the remote method await it after a while as expected", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);

        let promise = app.service.user.instance().setAndGet("Hello, World!");

        await sleep(50);

        assert.strictEqual(await promise, "Hello, World!");

        await client.close();
        await server.close();
    });

    it("should access to the corresponding singleton when passing DSN", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);

        server.register(app.service.user);
        client.register(app.service.user);

        assert.strictEqual(
            app.service.user.instance(server.dsn),
            app.service.user["remoteSingletons"][server.dsn]
        );

        await client.close();
        await server.close();
    });

    it("should not proxify any property functions in an instance", async () => {
        let server = await App.serve(config);
        let client = await App.connect(config);
        let newFn = () => { };

        server.register(app.service.user);
        client.register(app.service.user);

        assert.strictEqual(app.service.user.instance(App.local).setName["proxified"], true);
        assert.strictEqual(app.service.user.instance(App.local)["propFn"]["proxified"], undefined);

        app.service.user.instance(App.local)["propFn"] = newFn;
        assert.strictEqual(app.service.user.instance(App.local)["propFn"], newFn);

        await client.close();
        await server.close();
    });

    /////////////////////// Dependency Injection ///////////////////////////////

    it("should add dependency as expected", async () => {
        class Article {
            @app.service.user.inject()
            protected admin: User;

            getAdminName(): Promise<string> {
                return this.admin.getName();
            }
        }

        let server = await App.serve(config);
        let client = await App.connect(config);
        let article = new Article;

        server.register(app.service.user);
        client.register(app.service.user);

        assert.strictEqual(await article.getAdminName(), "Mr. World");

        await client.close();
        await server.close();
    });

    /////////////////////// Dependency Injection ///////////////////////////////

    it("should watch file change and reload module as expected", async function () {
        this.timeout(15000)
        let watcher = App.watch();
        let contents = await fs.readFile(app.service.user.path + ".js", "utf8");
        let newContents = contents.replace("return this.name", "return this.name + ' Budy'");

        assert.strictEqual(await app.service.user.instance(App.local).getName(), "Mr. World");

        await sleep(500); // wait a while for watcher to be ready
        fs.writeFileSync(app.service.user.path + ".js", newContents, "utf8");
        await new Promise(resolve => watcher.once("change", resolve));

        assert.strictEqual(await app.service.user.instance(App.local).getName(), "Mr. World Budy");

        watcher.close();
    });
});