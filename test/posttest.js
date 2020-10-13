const fs = require("fs-extra");

fs.rmdirSync(`${__dirname}/.build`, { recursive: true });
