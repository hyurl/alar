const { execSync } = require("child_process");

if (process.platform === "win32") {
    execSync("mkdir .\\test\\.build\\test\\json");
    execSync("copy .\\test\\json .\\test\\.build\\test\\json");
    execSync("npx tsc -p .\\test");
} else {
    execSync("mkdir -p ./test/.build/test");
    execSync("cp -R ./test/json ./test/.build/test");
    execSync("npx tsc -p ./test");
}
