const { execSync } = require("child_process");

if (process.platform === "win32") {
    execSync("rm .\\test\\.build -r -fo");
} else {
    execSync("rm -rf ./test/.build");
}
