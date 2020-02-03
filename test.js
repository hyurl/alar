const net = require("net");

const server = net.createServer(socket => {
    socket.on("error", console.log);
    setTimeout(() => {
        socket.destroy(new Error("something went wrong"));
    }, 1000);
});
server.listen(12345);

const client = net.createConnection(12345, "localhost");
client.on("error", (err) => {
    console.log(err);
    console.log(client.destroyed);
}).on("close", hadErr => {
    console.log(hadErr, client.destroyed);
});