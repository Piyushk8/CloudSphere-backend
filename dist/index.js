"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webSocketServiceInstance = void 0;
const http_1 = __importDefault(require("http"));
const WebsocketService_1 = require("./Websocket/WebsocketService");
const HttpService_1 = require("./http/HttpService");
// import { listBuckets } from "./AWS";
const HttpServiceInstance = new HttpService_1.HttpService();
const server = http_1.default.createServer(HttpServiceInstance.app);
exports.webSocketServiceInstance = new WebsocketService_1.WebSocketService(server);
server.listen(4000, () => {
    console.log("✅ server running on port", 4000);
});
const Docker = require('dockerode');
const docker = new Docker();
// async function measureSpinUp(image = 'alpine:latest') {
//   const start = Date.now();
//   const container = await docker.createContainer({
//     Image: image,
//     Cmd: ['sh', '-c', 'while true; do sleep 1000; done'],
//   });
//   await container.start();
//   const end = Date.now();
//   await container.remove({ force: true });
//   return end - start;
// }
// (async () => {
//   const times = [];
//   for (let i = 0; i < 10; i++) {
//     times.push(await measureSpinUp('alpine:latest'));
//     times.push(await measureSpinUp('ubuntu:20.04')); // Compare
//   }
//   console.log('Alpine:', times.filter((_, i) => i % 2 === 0));
//   console.log('Ubuntu:', times.filter((_, i) => i % 2 === 1));
// })();
