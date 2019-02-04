setImmediate(() => {
    console.log(1);
});

setImmediate(() => {
    console.log(2);
});

setTimeout(() => {
    console.log(3);
}, 0);

setTimeout(() => {
    console.log(4);
}, 0);