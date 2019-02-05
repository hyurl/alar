/* global app */

require("source-map-support/register");
const separ = require("..");
const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const sleep = require("sleep-promise");
const awaiter = require("tslib").__awaiter;
const Bootstrap = require("./app/bootstrap").default;
const User = require("./app/service/user").default;

describe("Separ ModuleProxy", () => {
    it("should create a root module proxy instance as expected", () => {
        var App = global["app"] = new separ.ModuleProxy("app", __dirname + "/app");

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

    it("shoul set singleton instance via instance() method as expected", () => {
        app.service.user.instance(app.service.user.create("Mr. Handsome"));
        assert.strictEqual(app.service.user.instance().name, "Mr. Handsome");
    });

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

    it("should serve an IPC service as expected", (done) => {
        awaiter(null, null, null, function* () {
            var sockPath = process.cwd() + "/separ.sock";
            var server = yield app.serve(sockPath);

            server.register(app.service.user);
            app.service.user.instance(app.service.user.create("Mr. World"));

            var client = yield app.connect(sockPath);

            client.register(app.service.user);

            assert.strictEqual(yield app.service.user.remote().getName(), "Mr. World");

            yield client.close();
            yield server.close();
            done();
        });
    });

    it("should serve an RPC service as expected", (done) => {
        awaiter(null, null, null, function* () {
            var config = { host: "127.0.0.1", port: 18888 };
            var server = yield app.serve(config);

            server.register(app.service.user);
            app.service.user.instance(app.service.user.create("Mr. World"));

            var client = yield app.connect(config);

            client.register(app.service.user);

            assert.strictEqual(yield app.service.user.remote().getName(), "Mr. World");

            yield client.close();
            yield server.close();
            done();
        });
    });
});