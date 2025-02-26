"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const WebsocketService_1 = require("./Websocket/WebsocketService");
const HttpService_1 = require("./http/HttpService");
const AWS_1 = require("./AWS");
const HttpServiceInstance = new HttpService_1.HttpService();
const server = http_1.default.createServer(HttpServiceInstance.app);
const webSocketService = new WebsocketService_1.WebSocketService(server);
// ✅ Fix CORS in Express Middleware
(0, AWS_1.listBuckets)();
server.listen(4000, () => {
    console.log("✅ server running on port", 4000);
});
