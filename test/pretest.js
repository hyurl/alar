const fs = require("fs-extra");
const { execSync } = require("child_process");


fs.mkdirSync(`${__dirname}/.build/test/`, { recursive: true });
fs.copySync(`${__dirname}/json`, `${__dirname}/.build/test/json`);
execSync("tsc -p test");
