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
const watcher_1 = require("./watcher");
class WebSocketService {
    constructor(server) {
        this.io = new socket_io_1.Server(server, { cors: { origin: "*" } });
        this.dockerManager = new DockerManager_1.DockerManager();
        this.activeTerminals = new Map();
        this.roomUsers = new Map();
        this.monitoredRooms = new Set();
        this.heartbeatInterval = null;
        // Start heartbeat to check container status
        this.startHeartbeat();
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
                    yield (0, watcher_1.watchRoomFiles)(roomId);
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
                    yield (0, watcher_1.watchRoomFiles)(roomId);
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
                    // Check if terminal already exists for reconnect
                    if (this.activeTerminals.has(key)) {
                        console.log(`🔄 Reconnecting to existing terminal ${key}`);
                        socket.emit("terminalCreated", { roomId, terminalId });
                        return;
                    }
                    // Create new PTY
                    const ptyProcess = yield (0, pty_1.createPtyProcess)(container.id);
                    this.activeTerminals.set(key, {
                        pty: ptyProcess,
                        containerId: container.id,
                    });
                    console.log(`✅ Terminal created: ${key} | Container: ${container.id}`);
                    ptyProcess.onData((data) => {
                        // console.log(`[PTY Output ${key}]:`, JSON.stringify(data));
                        this.io
                            .to(roomId)
                            .emit("terminal:output", { terminalId, data: data.toString() });
                    });
                    ptyProcess.onExit(({ exitCode }) => {
                        console.log(`❌ PTY ${key} exited with code: ${exitCode}`);
                        this.io.to(roomId).emit("terminal:exit", { terminalId });
                        this.activeTerminals.delete(key);
                    });
                    socket.emit("terminalCreated", { roomId, terminalId });
                }
                catch (error) {
                    console.error(`❌ Error creating terminal ${terminalId}:`, error);
                    socket.emit("error", `Failed to create terminal ${terminalId}`);
                }
            }));
            socket.on("terminal:write", ({ roomId, terminalId, data }) => {
                const key = `${roomId}:${terminalId}`;
                const terminal = this.activeTerminals.get(key);
                if (!terminal) {
                    console.warn(`⚠️ No active PTY for ${key}`);
                    socket.emit("error", `No terminal found for ${terminalId}`);
                    return;
                }
                // console.log(`📥 Writing to ${key}:`, JSON.stringify(data));
                terminal.pty.write(data);
            });
            socket.on("terminal:resize", ({ roomId, terminalId, cols, rows }) => {
                const key = `${roomId}:${terminalId}`;
                const terminal = this.activeTerminals.get(key);
                if (!terminal) {
                    console.warn(`⚠️ No active PTY for ${key}`);
                    return;
                }
                if (!cols || !rows || cols < 10 || rows < 5) {
                    console.warn(`⚠️ Ignoring invalid size for ${key}: ${cols}x${rows}`);
                    return;
                }
                if (terminal.pty.cols !== cols || terminal.pty.rows !== rows) {
                    console.log(`📏 Resizing PTY ${key} to ${cols}x${rows}`);
                    (0, pty_1.resizeTerminal)(terminal.pty, cols, rows);
                }
            });
            socket.on("disconnect", () => __awaiter(this, void 0, void 0, function* () {
                console.log(`❌ User ${socket.id} disconnected`);
                this.roomUsers.forEach((users, roomId) => {
                    if (users.has(socket.id)) {
                        users.delete(socket.id);
                        // Doesn’t kill PTYs here; let heartbeat handle cleanup
                        if (users.size === 0) {
                            console.log(`🛑 No more users in room ${roomId}, awaiting heartbeat cleanup`);
                            this.roomUsers.delete(roomId);
                            this.monitoredRooms.delete(roomId);
                            (0, watcher_1.stopWatchingRoomFiles)(roomId);
                        }
                    }
                });
            }));
        });
    }
    startHeartbeat() {
        return __awaiter(this, void 0, void 0, function* () {
            this.heartbeatInterval = setInterval(() => __awaiter(this, void 0, void 0, function* () {
                console.log(`🩺 Running heartbeat check for ${this.activeTerminals.size} terminals`);
                for (const [key, { pty, containerId }] of this.activeTerminals) {
                    const [roomId, terminalId] = key.split(":");
                    try {
                        const container = this.dockerManager.docker.getContainer(containerId);
                        yield container.inspect();
                        console.log(`✅ Container ${containerId} for terminal ${key} is running`);
                    }
                    catch (err) {
                        console.warn(`❌ Container ${containerId} for terminal ${key} not found, cleaning up`);
                        (0, pty_1.killTerminal)(pty);
                        this.activeTerminals.delete(key);
                        this.io.to(roomId).emit("terminal:exit", { terminalId });
                    }
                }
            }), 30000); // 30 sec health check
        });
    }
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
            console.log(`🛑 Heartbeat stopped`);
        }
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
    // Cleanup on server shutdown
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            this.stopHeartbeat();
            for (const [key, { pty }] of this.activeTerminals) {
                (0, pty_1.killTerminal)(pty);
                this.activeTerminals.delete(key);
            }
            console.log(`🧹 WebSocketService shutdown complete`);
        });
    }
}
exports.WebSocketService = WebSocketService;
