const { execSync } = require("child_process");

if (process.platform === "win32") {
    execSync("rmdir /S /Q .\\test\\.build");
} else {
    execSync("rm -rf ./test/.build");
}
