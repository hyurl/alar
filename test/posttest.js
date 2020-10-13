const fs = require("fs");

fs.rmdirSync(`${__dirname}/.build`, { recursive: true });
