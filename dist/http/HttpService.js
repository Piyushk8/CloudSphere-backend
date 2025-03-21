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
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs_1 = require("fs");
const Filewatcher_1 = require("../Websocket/Filewatcher");
const app = (0, express_1.default)();
const execPromise = (0, util_1.promisify)(child_process_1.exec);
app.use(express_1.default.json());
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
        //@ts-ignore
        // this.app.get("/files/:roomId",async (req: Request, res: Response): Promise<Response> => {
        //     try {
        //       const { roomId } = req.params;
        //       // const container = await this.dockerManager.getContainer(roomId);
        //       // if (!container) {
        //       //   return res.status(404).json({ error: "Container not found" });
        //       // }
        //       const fileTree = await this.dockerManager.getFileTree(roomId);
        //       console.log(fileTree)
        //       const transformedTree = assignIds(fileTree);
        //       res.json({
        //         transformedTree,
        //       });
        //     } catch (error) {
        //       console.error("Error fetching file tree:", error);
        //       return res
        //         .status(500)
        //         .json({ error: "Failed to fetch file structure" });
        //     }
        //   }
        // );
        this.app.get("/files/:roomId", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { roomId } = req.params;
                const fileTree = yield this.dockerManager.getFileTree(roomId);
                console.log("filetree", fileTree);
                // Start watching the room’s files if not already watched
                (0, Filewatcher_1.watchRoomFiles)(roomId);
                res.json({ transformedTree: assignIds(fileTree) });
            }
            catch (error) {
                console.error("Error fetching file tree:", error);
                res.status(500).json({ error: "Failed to fetch file structure" });
            }
        }));
        // ✅ Create Room with User-selected Programming Language
        //@ts-ignore
        this.app.post("/createRoom", (req, res) => __awaiter(this, void 0, void 0, function* () {
            // User selects a language
            try {
                const { language } = req.body; // User selects a language
                if (!language) {
                    return res
                        .status(400)
                        .json({ error: "Language selection is required" });
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
        this.app.post("/read-file", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                // const {path:filePath} = req.query
                const { containerId, path: filePath } = req.body;
                if (!filePath || !containerId) {
                    res.status(400).json({ error: "Invalid file path or containerId" });
                    return;
                }
                console.log("Checking file:", filePath, "in container:", containerId);
                const checkCommand = `docker exec ${containerId} test -f ${filePath} && echo "file" || echo "directory"`;
                (0, child_process_1.exec)(checkCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error("Error checking file type:", error);
                        res.status(500).json({ error: "Failed to check file type" });
                        return;
                    }
                    const trimmedOutput = stdout.trim().replace(/['"]+/g, ""); // ✅ Fix extra quotes
                    console.log("File type check output:", trimmedOutput);
                    if (trimmedOutput === "directory") {
                        res
                            .status(400)
                            .json({ error: "Path is a directory, not a file" });
                        return;
                    }
                    if (trimmedOutput === "file") {
                        const command = `docker exec ${containerId} cat ${filePath}`;
                        console.log("Executing command:", command); // ✅ Log command for debugging
                        (0, child_process_1.exec)(command, (error, stdout, stderr) => {
                            if (error) {
                                console.error("Error executing command:", error);
                                res
                                    .status(500)
                                    .json({ error: "Failed to read file from container" });
                                return;
                            }
                            if (stderr) {
                                console.error("Error output:", stderr);
                                res.status(500).json({ error: stderr });
                                return;
                            }
                            console.log("File content read successfully");
                            res.json({ content: stdout });
                        });
                    }
                    else {
                        res
                            .status(500)
                            .json({
                            error: `Unexpected output when checking file type: ${trimmedOutput}`,
                        });
                    }
                });
            }
            catch (error) {
                console.error("Unexpected error:", error);
                res.status(500).json({ error: "Failed to read file" });
            }
        }));
        //@ts-ignore
        this.app.post("/save-file", (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const { containerId, path: filePath, content } = req.body;
                if (!containerId || !filePath || typeof content !== "string") {
                    return res.status(400).json({ error: "Invalid parameters" });
                }
                // Step 1: Ensure directory exists inside container
                const dirPath = path_1.default.dirname(filePath);
                yield execPromise(`docker exec ${containerId} sh -c "mkdir -p '${dirPath}'"`);
                // Step 2: Save content to a temp file locally (base64 encoded)
                const tempFile = path_1.default.join(__dirname, "temp.b64");
                (0, fs_1.writeFileSync)(tempFile, Buffer.from(content, "utf8").toString("base64"));
                // Step 3: Copy the base64 file to the container
                yield execPromise(`docker cp ${tempFile} ${containerId}:/tmp/temp.b64`);
                // Step 4: Decode inside the container & move to destination
                yield execPromise(`docker exec ${containerId} sh -c "base64 -d /tmp/temp.b64 > '${filePath}'"`);
                // Step 5: Cleanup local temp file
                (0, fs_1.unlinkSync)(tempFile);
                res.json({ success: true });
            }
            catch (error) {
                console.error("Failed to write file inside container:", error);
                res.status(500).json({ error: "Failed to save file", details: error.message });
            }
        }));
        this.app.use("/proxy/:roomId/:port", (req, res) => __awaiter(this, void 0, void 0, function* () {
            const { roomId, port } = req.params;
            try {
                const containerIP = yield this.dockerManager.getContainerIP(roomId);
                if (!containerIP)
                    throw new Error("Container IP not found");
                // console.log(containerIP)
                // console.log("getting process")
                const process = yield this.dockerManager.getContainerProcesses(roomId);
                // console.log('get process result ',process)
                // console.log(this.dockerManager.parseListeningProcesses)
                const targetUrl = `http://${containerIP}:${port}${req.url}`;
                console.log("Proxying to:", targetUrl);
                // const response = await axios.get(targetUrl, { responseType: "stream" });
                // response.data.pipe(res);
            }
            catch (err) {
                console.error("Proxy Error:", err);
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
// 🔹 Supported Languages & Their Configurations
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
function assignIds(tree, idCounter = { value: 1 }) {
    return tree.map((node) => {
        const newNode = {
            id: String(idCounter.value++), // Ensure each node has a unique ID
            name: node.name,
            path: node.path,
            type: node.type,
            children: node.children ? assignIds(node.children, idCounter) : undefined,
        };
        return newNode;
    });
}
