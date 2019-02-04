import "./core";
// import sleep = require("sleep-promise");

(async () => {
    console.log(app.user.vip.instance().getMyName());
    var name = await app.user.member.instance().getName();

    console.log(name);
})();