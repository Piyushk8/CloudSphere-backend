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
exports.HttpService = void 0;
const express_1 = __importDefault(require("express"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const DockerManager_1 = require("../Docker/DockerManager");
const crypto_1 = require("crypto");
const http_1 = require("http");
const WebsocketService_1 = require("../Websocket/WebsocketService");
class HttpService {
    constructor() {
        this.app = (0, express_1.default)();
        this.server = (0, http_1.createServer)(this.app);
        this.websocketService = new WebsocketService_1.WebSocketService(this.server);
        this.dockerManager = new DockerManager_1.DockerManager();
        this.app.use(express_1.default.json());
        this.app.use((0, cors_1.default)({
            origin: "http://localhost:5173",
            methods: ["GET", "POST"],
            credentials: true,
        }));
        // ✅ Test API
        this.app.get("/", (req, res) => {
            res.json({ message: "Hello, Cloud IDE is running!" });
        });
        // ✅ Retrieve File Tree from Inside Docker Container
        this.app.get("/files/:roomId", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { roomId } = req.params;
                const container = yield this.dockerManager.getContainer(roomId);
                if (!container) {
                    return res.status(404).json({ error: "Container not found" });
                }
                const exec = yield container.exec({
                    Cmd: ["sh", "-c", "ls -R /workspace"], // List files inside the container
                    AttachStdout: true,
                    AttachStderr: true,
                });
                const stream = yield exec.start({});
                let output = "";
                stream.on("data", (chunk) => {
                    output += chunk.toString();
                });
                stream.on("end", () => {
                    return res.json({ fileTree: parseFileTree(output) }); // Ensure returning response
                });
            }
            catch (error) {
                console.error("Error fetching file tree:", error);
                return res.status(500).json({ error: "Failed to fetch file structure" });
            }
        }));
        // ✅ Create Room with User-selected Programming Language
        this.app.post("/createRoom", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { language } = req.body; // User selects a language
                if (!language) {
                    return res.status(400).json({ error: "Language selection is required" });
                }
                const languageConfig = getLanguageConfig(language);
                if (!languageConfig) {
                    return res.status(400).json({ error: "Unsupported language" });
                }
                const roomId = `room-${Date.now()}-${(0, crypto_1.randomUUID)()}`;
                const workspacePath = path_1.default.resolve("storage", roomId);
                // Create workspace directory
                yield promises_1.default.mkdir(workspacePath, { recursive: true });
                const containerOptions = {
                    image: "node:18", // Default to Node.js, or use selected language
                    roomId,
                    exposedPort: 8080, // Example port
                    envVars: ["NODE_ENV=development"], // Adjust for other languages
                };
                const { containerId, hostPort } = yield this.dockerManager.createContainer(containerOptions);
                if (!containerId || !hostPort)
                    return res.json({});
                return res.json({
                    message: "Room created successfully",
                    roomId,
                    containerId,
                    hostPort,
                    workspacePath,
                });
            }
            catch (error) {
                console.error("Error creating room:", error);
                return res.status(500).json({ error: "Failed to create room" });
            }
        }));
    }
    start(port) {
        this.server.listen(port, () => {
            console.log(`🚀 Server running on port ${port}`);
        });
    }
}
exports.HttpService = HttpService;
// 🔹 Supported Languages & Their Configurations
function getLanguageConfig(language) {
    const config = {
        node: { image: "node:18", port: 8080, envVars: ["NODE_ENV=development"] },
        javascript: { image: "node:18", port: 8080, envVars: ["NODE_ENV=development"] },
        python: { image: "python:3.10", port: 5000, envVars: ["FLASK_ENV=development"] },
        java: { image: "openjdk:17", port: 8080, envVars: ["JAVA_OPTS=-Xmx512m"] },
        golang: { image: "golang:1.19", port: 8080, envVars: [] },
        rust: { image: "rust:latest", port: 8080, envVars: [] },
    };
    return config[language.toLowerCase()] || null;
}
// 🔹 Parse File Tree Output from Docker
function parseFileTree(output) {
    const tree = {};
    const lines = output.split("\n");
    let currentDir = tree;
    for (const line of lines) {
        if (line.endsWith(":")) {
            const pathParts = line.replace(":", "").split("/");
            currentDir = tree;
            for (const part of pathParts.slice(2)) {
                if (!currentDir[part])
                    currentDir[part] = {};
                currentDir = currentDir[part];
            }
        }
        else if (line.trim()) {
            currentDir[line.trim()] = null;
        }
    }
    return tree;
}
