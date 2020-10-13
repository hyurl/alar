const fs = require("fs-extra");
const { execFileSync } = require("child_process");


fs.mkdirSync(`${__dirname}/.build/test/`, { recursive: true });
fs.copySync(`${__dirname}/json`, `${__dirname}/.build/test/json`);
execFileSync("tsc", ["-p", "test"]);
