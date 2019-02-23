const alar = require("../..");
const config = require("../app/config").default;
const awaiter = require("tslib").__awaiter;

var app = new alar.ModuleProxy("app", __dirname + "/../app");

awaiter(null, null, null, function* () {
    var server = yield app.serve(config);

    server.register(app.service.user);

    app.service.user.instance().setName("Mr. Handsome");

    process.send("ready");
});