/* global app */

require("source-map-support/register");
const alar = require("..");
const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const sleep = require("sleep-promise");
const awaiter = require("tslib").__awaiter;
const Bootstrap = require("./app/bootstrap").default;
const User = require("./app/service/user").default;
const config = require("./app/config").default;
const ChildProcess = require("child_process");

function fork(filename) {
    return new Promise((resolve, reject) => {
        var proc = ChildProcess.fork(filename);

        proc.on("error", reject).on("message", msg => {
            if (msg === "ready") {
                resolve(proc);
            }
        });
    });
}

describe("Alar ModuleProxy", () => {
    it("should create a root module proxy instance as expected", () => {
        var App = global["app"] = new alar.ModuleProxy("app", __dirname + "/app");

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
        assert.strictEqual(app.resolve(app.service.user.path), "app.service.user");
        assert.strictEqual(app.resolve(app.service.user.path + ".js"), "app.service.user");
    });

    it("should create instances via create() method asexpected", () => {
        var user1 = app.service.user.create("Mr. Handsome");
        var user2 = app.service.user.create("Mr. World");

        assert.ok(user1 instanceof User);
        assert.ok(user2 instanceof User);
        assert.strictEqual(user1.name, "Mr. Handsome");
        assert.strictEqual(user2.name, "Mr. World");
        assert.strictEqual(user1.getName(), user1.name);
        assert.strictEqual(user2.getName(), user2.name);
    });

    it("should create instance via ctor property as expected", () => {
        var bootstrap = new app.bootstrap.ctor();

        bootstrap.init();
        assert.ok(bootstrap instanceof Bootstrap);
        assert.deepStrictEqual(bootstrap.data, ["hello", "world"]);
    });

    it("should get singleton instance via instance() method as expected", () => {
        app.service.user.instance().name = "Mr. Handsome";
        assert.ok(app.service.user.instance() instanceof User);
        assert.strictEqual(app.service.user.instance().name, "Mr. Handsome");
        app.service.user.instance().name = "Mr. World";
        assert.strictEqual(app.service.user.instance().name, "Mr. World");
    });

    it("should access to a prototype module as expected", () => {
        assert.strictEqual(app.config.name, "app.config");
        assert.strictEqual(app.config.path, path.normalize(__dirname + "/app/config"));
        assert.deepStrictEqual(app.config.proto, config);
    });

    it("should create instance from a prototype module as expected", () => {
        let ins = app.config.create();
        assert.strictEqual(Object.getPrototypeOf(ins), config);
    });

    it("should use the prototype module as singleton as expected", () => {
        let ins = app.config.instance();
        assert.strictEqual(ins, config);
    });

    // Due to **chokaidar**'s bug of [Not working with fs.writeFile](https://github.com/paulmillr/chokidar/issues/790)
    // the watching and reloading feature cannot be tested here, you could just 
    // test it in your own project.
    // 
    // it("should watch file change and reload module as expected", (done) => {
    //     awaiter(null, null, null, function* () {
    //         var watcher = app.watch();
    //         var user = app.service.user.create("Mr. Handsome");
    //         var contents = yield fs.readFile(app.service.user.path + ".js", "utf8");
    //         var newContents = contents.replace("return this.name", "return this.name + ' World'");
    //         let ins = app.service.user.instance();

    //         app.service.user.instance().name = "Mr. Handsome";
    //         assert.strictEqual(user.getName(), "Mr. Handsome");
    //         assert.strictEqual(app.service.user.instance().getName(), "Mr. Handsome");

    //         yield fs.writeFile(app.service.user.path + ".js", newContents, "utf8");
    //         yield sleep(100); // wait a while for watcher to refresh the module.

    //         user = app.service.user.create("Mr. Handsome");
    //         app.service.user.instance().name = "Mr. Handsome";
    //         assert.strictEqual(user.getName(), "Mr. Handsome World");
    //         assert.strictEqual(app.service.user.instance().getName(), "Mr. Handsome World");

    //         yield fs.writeFile(app.service.user.path + ".js", contents, "utf8");

    //         watcher.close();
    //         done();
    //     });
    // });

    it("should use a custom loader to load JSON module as expected", () => {
        var json = new alar.ModuleProxy("json", __dirname + "/json");
        var cache = {};
        json.setLoader({
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
        assert.strictEqual(Object.getPrototypeOf(json.test.create()), json.test.instance());
    });

    it("should serve an IPC service as expected", (done) => {
        awaiter(null, null, null, function* () {
            var sockPath = process.cwd() + "/alar.sock";
            var server = yield app.serve(sockPath);

            server.register(app.service.user);

            var client = yield app.connect(sockPath);

            client.register(app.service.user);

            assert.strictEqual(yield app.service.user.instance().getName(), "Mr. World");

            yield client.close();
            yield server.close();
            done();
        });
    });

    it("should serve an RPC service as expected", (done) => {
        awaiter(null, null, null, function* () {
            var server = yield app.serve(config);

            server.register(app.service.user);

            var client = yield app.connect(config);

            client.register(app.service.user);

            assert.strictEqual(yield app.service.user.instance().getName(), "Mr. World");

            yield client.close();
            yield server.close();
            done();
        });
    });

    it("should reconnect the RPC service in the background automatically", (done) => {
        awaiter(null, null, null, function* () {
            var filename = __dirname + "/server/index.js";
            var proc = yield fork(filename);
            var client = yield app.connect(config);

            client.register(app.service.user);

            // kill the server and restart it, the client will reconnect in the
            // background automatically.
            proc.kill();
            proc = yield fork(filename);

            while (!client.connected) {
                yield sleep(100);
            }

            assert.strictEqual(yield app.service.user.instance().getName(), "Mr. Handsome");

            yield client.close();
            proc.kill();
            yield sleep(100);
            done();
        });
    });

    it("should reject error is no remote service is available", (done) => {
        awaiter(null, null, null, function* () {
            let err;

            try {
                app.service.user.noLocal();
                yield app.service.user.instance().getName();
            } catch (e) {
                err = e;
            }

            assert.ok(err instanceof ReferenceError);

            done();
        });
    });

    it("should subscribe and publish an event as expected", (done) => {
        awaiter(null, null, null, function* () {
            var server = yield app.serve(config);
            var client = yield app.connect(config);
            var data;

            client.subscribe("set-data", msg => {
                data = msg;
            });

            server.publish("set-data", "Mr. World");

            while (!data) {
                yield sleep(50);
            }

            assert.strictEqual(data, "Mr. World");

            yield client.close();
            yield server.close();
            done();
        });
    });

    it("should subscribe and publish multiple events as expected", (done) => {
        awaiter(null, null, null, function* () {
            var server = yield app.serve(config);
            var client = yield app.connect(config);
            var data;
            var data1;
            var data2;

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
                yield sleep(50);
            }

            assert.strictEqual(data, "Mr. World");
            assert.strictEqual(data1, "Mr. World");
            assert.strictEqual(data2, "Mr. World");

            yield client.close();
            yield server.close();
            done();
        });
    });

    it("should unsubscribe event handles as expected", (done) => {
        awaiter(null, null, null, function* () {
            var server = yield app.serve(config);
            var client = yield app.connect(config);
            var listner = msg => null;
            var listner2 = msg => null;

            client.subscribe("set-data", listner)
                .subscribe("set-data", listner2)
                .subscribe("set-data-2", listner)
                .subscribe("set-data-2", listner2)

            client.unsubscribe("set-data", listner);
            client.unsubscribe("set-data-2");

            assert.deepStrictEqual(client.events, {
                "set-data": [listner2]
            });

            yield client.close();
            yield server.close();
            done();
        });
    });
});