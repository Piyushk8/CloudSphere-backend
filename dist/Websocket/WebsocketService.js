"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketService = void 0;
// WebSocketService.ts
const socket_io_1 = require("socket.io");
const DockerManager_1 = require("../Docker/DockerManager");
const pty_1 = require("../terminal/pty");
class WebSocketService {
    constructor(server) {
        this.io = new socket_io_1.Server(server, { cors: { origin: "*" } });
        this.dockerManager = new DockerManager_1.DockerManager();
        this.activeTerminals = new Map();
        this.roomUsers = new Map();
        this.io.on("connection", (socket) => {
            console.log(`User connected: ${socket.id}`);
            // Create a new room (workspace + container)
            socket.on("createRoom", (_a) => __awaiter(this, [_a], void 0, function* ({ image = "node:18" }) {
                try {
                    const roomId = `room-${Date.now()}`;
                    const { containerId, hostPort } = yield this.dockerManager.createContainer({
                        image,
                        roomId,
                        exposedPort: 8080,
                    });
                    socket.emit("roomCreated", { roomId, containerId, hostPort });
                    console.log(`✅ Room created: ${roomId} | Container: ${containerId}`);
                }
                catch (error) {
                    console.error("❌ Error creating room:", error);
                    socket.emit("error", "Failed to create room");
                }
            }));
            // Join an existing room
            socket.on("joinRoom", (_a) => __awaiter(this, [_a], void 0, function* ({ roomId }) {
                console.log(`👤 User ${socket.id} joining room: ${roomId}`);
                if (!this.roomUsers.has(roomId)) {
                    this.roomUsers.set(roomId, new Set());
                }
                this.roomUsers.get(roomId).add(socket.id);
                if (!this.activeTerminals.has(roomId)) {
                    try {
                        const container = yield this.dockerManager.getContainer(roomId);
                        if (!(container === null || container === void 0 ? void 0 : container.id))
                            throw new Error(`🚨 Container not found for roomId: ${roomId}`);
                        const ptyProcess = yield (0, pty_1.createPtyProcess)(container.id);
                        this.activeTerminals.set(roomId, ptyProcess);
                        console.log("🅿️pty process", ptyProcess);
                        ptyProcess.onData((data) => {
                            console.log("pty output", data);
                            this.io.to(roomId).emit("terminal:output", data.toString());
                        });
                    }
                    catch (error) {
                        console.error("❌ Error setting up PTY:", error);
                        socket.emit("error", "Failed to create terminal session");
                        return;
                    }
                }
                else {
                    console.log(`🔄 Reattaching to existing terminal for room: ${roomId}`);
                }
                socket.join(roomId);
                socket.on("terminal:write", (data) => {
                    if (this.activeTerminals.has(roomId)) {
                        console.log(`📥 Received from frontend:`, JSON.stringify(data));
                        // Ensure proper newline handling
                        if (data === "\r") {
                            data = "\n"; // Convert Carriage Return to Newline
                        }
                        this.activeTerminals.get(roomId).write(data);
                    }
                });
                socket.on("terminal:resize", ({ cols, rows }) => {
                    if (this.activeTerminals.has(roomId)) {
                        this.activeTerminals.get(roomId).resize(cols, rows);
                    }
                });
                // Handle user disconnect
                socket.on("disconnect", () => __awaiter(this, void 0, void 0, function* () {
                    console.log(`❌ User ${socket.id} disconnected from room ${roomId}`);
                    // this.roomUsers.get(roomId)?.delete(socket.id);
                    // if (this.roomUsers.get(roomId)?.size === 0) {
                    //   console.log(
                    //     `🛑 No more users in room ${roomId}, shutting down PTY and container`
                    //   );
                    //   if (this.activeTerminals.has(roomId)) {
                    //     this.activeTerminals.get(roomId).kill();
                    //     this.activeTerminals.delete(roomId);
                    //   }
                    //   // await this.dockerManager.removeContainer(roomId);
                    //   // this.roomUsers.delete(roomId);
                    // }
                }));
            }));
        });
    }
}
exports.WebSocketService = WebSocketService;
