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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketService = void 0;
const socket_io_1 = require("socket.io");
const DockerManager_1 = require("../Docker/DockerManager");
const pty_1 = require("../terminal/pty");
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execPromise = (0, util_1.promisify)(child_process_1.exec);
class WebSocketService {
    constructor(server) {
        this.io = new socket_io_1.Server(server, { cors: { origin: "*" } });
        this.dockerManager = new DockerManager_1.DockerManager();
        this.activeTerminals = new Map();
        this.roomUsers = new Map();
        this.monitoredRooms = new Set(); // Prevent duplicate monitoring
        this.io.on("connection", (socket) => {
            console.log(`👤 User connected: ${socket.id}`);
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
            socket.on("joinRoom", (_a) => __awaiter(this, [_a], void 0, function* ({ roomId }) {
                console.log(`👤 User ${socket.id} joining room: ${roomId}`);
                if (!this.roomUsers.has(roomId)) {
                    this.roomUsers.set(roomId, new Set());
                }
                this.roomUsers.get(roomId).add(socket.id);
                socket.join(roomId);
                try {
                    const container = yield this.dockerManager.getContainer(roomId);
                    if (!(container === null || container === void 0 ? void 0 : container.id)) {
                        throw new Error(`🚨 Container not found for roomId: ${roomId}`);
                    }
                    socket.emit("roomJoined", { roomId, containerId: container.id });
                    // Start port monitoring if not already active
                    if (!this.monitoredRooms.has(roomId)) {
                        this.dockerManager.monitorPorts(roomId, container.id);
                        this.monitoredRooms.add(roomId);
                    }
                }
                catch (error) {
                    console.error("❌ Error in joinRoom:", error);
                    socket.emit("error", "Failed to join room");
                }
            }));
            socket.on("createTerminal", (_a) => __awaiter(this, [_a], void 0, function* ({ roomId, terminalId }) {
                try {
                    const container = yield this.dockerManager.getContainer(roomId);
                    if (!(container === null || container === void 0 ? void 0 : container.id)) {
                        throw new Error(`🚨 Container not found for roomId: ${roomId}`);
                    }
                    const key = `${roomId}:${terminalId}`;
                    if (!this.activeTerminals.has(key)) {
                        const ptyProcess = yield (0, pty_1.createPtyProcess)(container.id);
                        this.activeTerminals.set(key, ptyProcess);
                        ptyProcess.onData((data) => {
                            console.log(`[PTY Output ${key}]:`, JSON.stringify(data));
                            this.io.to(roomId).emit("terminal:output", { terminalId, data: data.toString() });
                        });
                        ptyProcess.onExit(({ exitCode }) => {
                            console.log(`❌ PTY ${key} exited with code: ${exitCode}`);
                            this.io.to(roomId).emit("terminal:exit", { terminalId });
                            this.activeTerminals.delete(key);
                        });
                        // ptyProcess.on("error", (error) => {
                        //   console.error(`❌ PTY ${key} error:`, error);
                        //   socket.emit("error", `Terminal ${terminalId} encountered an error`);
                        // });
                        console.log(`✅ Terminal ${key} created`);
                    }
                    socket.emit("terminalCreated", { roomId, terminalId });
                }
                catch (error) {
                    console.error(`❌ Error creating terminal ${terminalId}:`, error);
                    socket.emit("error", `Failed to create terminal ${terminalId}`);
                }
            }));
            socket.on("terminal:write", ({ roomId, terminalId, data }) => {
                const key = `${roomId}:${terminalId}`;
                const pty = this.activeTerminals.get(key);
                if (!pty) {
                    console.warn(`⚠️ No active PTY for ${key}`);
                    socket.emit("error", `No terminal found for ${terminalId}`);
                    return;
                }
                console.log(`📥 Writing to ${key}:`, JSON.stringify(data));
                pty.write(data);
            });
            socket.on("terminal:resize", ({ roomId, terminalId, cols, rows }) => {
                const key = `${roomId}:${terminalId}`;
                const pty = this.activeTerminals.get(key);
                if (!pty) {
                    console.warn(`⚠️ No active PTY for ${key}`);
                    return;
                }
                if (!cols || !rows || cols < 10 || rows < 5) {
                    console.warn(`⚠️ Ignoring invalid size for ${key}: ${cols}x${rows}`);
                    return;
                }
                if (pty.cols !== cols || pty.rows !== rows) {
                    console.log(`📏 Resizing PTY ${key} to ${cols}x${rows}`);
                    (0, pty_1.resizeTerminal)(pty, cols, rows);
                }
            });
            socket.on("disconnect", () => __awaiter(this, void 0, void 0, function* () {
                console.log(`❌ User ${socket.id} disconnected`);
                this.roomUsers.forEach((users, roomId) => {
                    if (users.has(socket.id)) {
                        users.delete(socket.id);
                        if (users.size === 0) {
                            console.log(`🛑 No more users in room ${roomId}, shutting down PTYs`);
                            this.activeTerminals.forEach((pty, key) => {
                                if (key.startsWith(`${roomId}:`)) {
                                    (0, pty_1.killTerminal)(pty);
                                    this.activeTerminals.delete(key);
                                }
                            });
                            this.roomUsers.delete(roomId);
                            this.monitoredRooms.delete(roomId); // Cleanup monitoring
                        }
                    }
                });
            }));
        });
    }
    emitToRoom(roomId, event, tree) {
        return __awaiter(this, void 0, void 0, function* () {
            const sanitizedRoomId = path_1.default.basename(roomId);
            console.log("Emitting directory update:", sanitizedRoomId, tree);
            if (!tree) {
                console.warn("Warning: Empty file tree");
                return;
            }
            this.io.to(sanitizedRoomId).emit("directory:changed", tree);
        });
    }
}
exports.WebSocketService = WebSocketService;
