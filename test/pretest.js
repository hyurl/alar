const { execSync } = require("child_process");

if (process.platform === "win32") {
    execSync("mkdir -p .\\test\\.build\\test");
    execSync("cp -R .\\test\\json .\\test\\.build\\test");
    execSync("tsc -p .\\test");
} else {
    execSync("mkdir -p ./test/.build/test");
    execSync("cp -R ./test/json ./test/.build/test");
    execSync("tsc -p ./test");
}
