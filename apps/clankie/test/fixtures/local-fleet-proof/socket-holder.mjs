// The parent's already-connected HTTP socket is inherited as fd 3. Do not read
// or write it: retaining the descriptor supplies a real second kernel owner.
process.send({ ready: true, pid: process.pid });
setInterval(() => {}, 1_000);
