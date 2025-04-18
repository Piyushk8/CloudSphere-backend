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
const http_1 = require("http");
const cors_1 = __importDefault(require("cors"));
const DockerManager_1 = require("../Docker/DockerManager");
const WebsocketService_1 = require("../Websocket/WebsocketService");
const crypto_1 = require("crypto");
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config(); // This will load variables from .env
const AWS_1 = require("../AWS");
const execPromise = (0, util_1.promisify)(child_process_1.exec);
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
        // Test API
        this.app.get("/", (req, res) => {
            res.json({ message: "Hello, Cloud IDE is running!" });
        });
        // Retrieve File Tree
        //@ts-ignore
        this.app.get("/files/:roomId", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { roomId } = req.params;
                const fileTree = yield this.dockerManager.getFileTree(roomId);
                if (!fileTree || fileTree.length === 0) {
                    return res.status(404).json({ error: "No file tree found for room" });
                }
                // Start watching files (will skip if already watching)
                const transformedTree = assignIds(fileTree);
                res.json({ transformedTree });
            }
            catch (error) {
                console.error("Error fetching file tree:", error);
                res.status(500).json({ error: "Failed to fetch file structure" });
            }
        }));
        // Create Room
        //@ts-ignore
        this.app.post("/createRoom", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { language } = req.body;
                if (!language) {
                    return res
                        .status(400)
                        .json({ error: "Language selection is required" });
                }
                console.log("langusge", language);
                const languageConfig = getLanguageConfig(language);
                if (!languageConfig) {
                    return res.status(400).json({ error: "Unsupported language" });
                }
                const roomId = `room-${Date.now()}-${(0, crypto_1.randomUUID)()}`;
                console.log("creating");
                const containerOptions = {
                    image: languageConfig.image,
                    roomId,
                    exposedPort: languageConfig.port,
                    envVars: languageConfig.envVars,
                };
                console.log("creating");
                const { containerId, hostPort } = yield this.dockerManager.createContainer(containerOptions);
                if (!containerId || !hostPort) {
                    return res.status(500).json({ error: "Failed to create container" });
                }
                console.log(containerId, hostPort, process.env.CLOUDFLARE_R2_BUCKET);
                const tempDirPath = path_1.default.resolve("temp", roomId);
                // Create a temporary directory to store files from R2
                // await fs.mkdir(tempDirPath, { recursive: true });
                // Download the files from the specified R2 bucket and folder
                yield (0, AWS_1.streamR2FilesToContainer)(process.env.CLOUDFLARE_R2_BUCKET || "", "base/reactjs", containerId, "/workspace");
                // await copyFilesToContainer(containerId, tempDirPath, "/workspace"); // Change '/workspace' if needed
                res.json({
                    message: "Room created successfully",
                    roomId,
                    containerId,
                    hostPort,
                    tempDirPath
                });
            }
            catch (error) {
                console.error("Error creating room:", error);
                res.status(500).json({ error: "Failed to create room" });
            }
        }));
        // Read File
        //@ts-ignore
        this.app.post("/read-file", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { containerId, path: filePath, roomId } = req.body;
                if (!filePath || !containerId) {
                    return res
                        .status(400)
                        .json({ error: "Invalid file path or containerId" });
                }
                const output = yield this.dockerManager.readFile(roomId, filePath);
                res.json({ content: output });
            }
            catch (error) {
                console.error("Error reading file:", error);
                res.status(500).json({ error: "Failed to read file" });
            }
        }));
        // Save File
        //@ts-ignore
        this.app.post("/save-file", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { containerId, path: filePath, content, roomId } = req.body;
                if (!containerId ||
                    !filePath ||
                    typeof content !== "string" ||
                    !roomId) {
                    return res.status(400).json({ error: "Invalid parameters" });
                }
                console.log(`Saving file: ${filePath} in container ${containerId} for room ${roomId}`);
                const dockerManager = new DockerManager_1.DockerManager(); // Should be injected or singleton in practice
                yield dockerManager.writeFile(roomId, filePath, content);
                console.log(`File ${filePath} saved successfully`);
                res.json({ success: true });
            }
            catch (error) {
                console.error("Failed to save file:", error);
                res
                    .status(500)
                    .json({
                    error: "Failed to save file",
                    details: error.message,
                });
            }
        }));
        // Proxy Route (Simplified, assuming completion elsewhere)
        this.app.use("/proxy/:roomId/:port", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { roomId, port } = req.params;
                const containerIP = yield this.dockerManager.getContainerIP(roomId);
                if (!containerIP)
                    throw new Error("Container IP not found");
                res.status(501).send("Proxy not fully implemented");
            }
            catch (error) {
                console.error("Proxy error:", error);
                res.status(500).send("Proxy error");
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
// Language Configurations
function getLanguageConfig(language) {
    const config = {
        node: { image: "node:18", port: 8080, envVars: ["NODE_ENV=development"] },
        javascript: {
            image: "node:18",
            port: 8080,
            envVars: ["NODE_ENV=development"],
        },
        python: {
            image: "python:3.10",
            port: 5000,
            envVars: ["FLASK_ENV=development"],
        },
        java: { image: "openjdk:17", port: 8080, envVars: ["JAVA_OPTS=-Xmx512m"] },
        golang: { image: "golang:1.19", port: 8080, envVars: [] },
        rust: { image: "rust:latest", port: 8080, envVars: [] },
        reactjs: {
            image: "node:18", // we'll build this Docker image
            port: 5173,
            envVars: ["HOST=0.0.0.0", "PORT=5173"],
        },
    };
    return config[language.toLowerCase()] || null;
}
// Assign IDs to File Tree
function assignIds(tree, idCounter = { value: 1 }) {
    return tree.map((node) => ({
        id: node.id || String(idCounter.value++),
        name: node.name,
        path: node.path,
        type: node.type,
        children: node.children ? assignIds(node.children, idCounter) : undefined,
    }));
}
