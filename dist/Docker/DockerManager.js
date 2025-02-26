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
exports.DockerManager = void 0;
const dockerode_1 = __importDefault(require("dockerode"));
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
class DockerManager {
    constructor() {
        this.docker = new dockerode_1.default();
    }
    createContainer(options) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { image, roomId, exposedPort = 8080, envVars = [] } = options;
                const hostPort = yield this.getAvailablePort(4000, 5000); // Ensure an available port
                const workspacePath = path_1.default.resolve("storage", roomId);
                // Ensure the workspace directory exists before creating the container
                yield promises_1.default.mkdir(workspacePath, { recursive: true });
                // Check if the image exists locally; if not, pull it
                const images = yield this.docker.listImages();
                const imageExists = images.some((img) => { var _a; return (_a = img.RepoTags) === null || _a === void 0 ? void 0 : _a.includes(image); });
                if (!imageExists) {
                    console.log(`❌ Image '${image}' not found locally. Pulling from Docker Hub...`);
                    yield new Promise((resolve, reject) => {
                        this.docker.pull(image, (err, stream) => {
                            if (err) {
                                console.error("❌ Error pulling image:", err);
                                return reject(err);
                            }
                            this.docker.modem.followProgress(stream, () => {
                                console.log(`✅ Image '${image}' pulled successfully.`);
                                resolve();
                            });
                        });
                    });
                }
                // Create the Docker container
                const container = yield this.docker.createContainer({
                    Image: image,
                    name: `room-${roomId}`,
                    Tty: true,
                    OpenStdin: true,
                    AttachStdin: true,
                    AttachStdout: true,
                    AttachStderr: true,
                    Env: envVars, // Pass environment variables
                    ExposedPorts: { [`${exposedPort}/tcp`]: {} },
                    HostConfig: {
                        PortBindings: { [`${exposedPort}/tcp`]: [{ HostPort: `${hostPort}` }] },
                        Binds: [`${workspacePath}:/workspace`], // Bind workspace directory
                        Privileged: false, // Do not enable unless required
                        AutoRemove: true, // Automatically remove container on stop
                    },
                });
                yield container.start();
                console.log(`✅ Container started for '${roomId}' using '${image}' on port ${hostPort}`);
                return { containerId: container.id, hostPort };
            }
            catch (error) {
                console.error("❌ Error creating container:", error.message || error);
                throw error;
            }
        });
    }
    getContainer(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const containers = yield this.docker.listContainers({ all: true });
                const found = containers.filter((c) => c.Names.includes(`/room-${roomId}`));
                if (!found) {
                    console.error(`🚨 Container not found for roomId: ${roomId}`);
                    return null;
                }
                return this.docker.getContainer(found[0].Id);
            }
            catch (error) {
                // console.error("❌ Error retrieving container:", error);
                return null;
            }
        });
    }
    removeContainer(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const container = yield this.getContainer(roomId);
                if (!container) {
                    console.log(`🛑 No container found for roomId: ${roomId}`);
                    return;
                }
                console.log(`🛑 Stopping and removing container: ${roomId}`);
                yield container.stop();
                yield container.remove();
                console.log(`✅ Container removed successfully: ${roomId}`);
            }
            catch (error) {
                console.error("❌ Error removing container:", error.message || error);
            }
        });
    }
    getAvailablePort(start, end) {
        return __awaiter(this, void 0, void 0, function* () {
            const net = require("net");
            for (let port = start; port <= end; port++) {
                const server = net.createServer();
                try {
                    yield new Promise((resolve, reject) => {
                        server.once("error", reject);
                        server.once("listening", () => {
                            server.close(() => resolve());
                        });
                        server.listen(port);
                    });
                    return port; // Found an available port
                }
                catch (_a) {
                    // Port is in use, try next one
                }
                finally {
                    server.close();
                }
            }
            throw new Error("❌ No available ports found in the range!");
        });
    }
    //helpers 
    execInContainer(roomId, command) {
        return __awaiter(this, void 0, void 0, function* () {
            const container = yield this.getContainer(roomId);
            if (!container)
                throw new Error(`Container for room '${roomId}' not found`);
            const exec = yield container.exec({
                Cmd: ["sh", "-c", command],
                AttachStdout: true,
                AttachStderr: true,
            });
            const stream = yield exec.start({});
            let output = "";
            return new Promise((resolve) => {
                stream.on("data", (chunk) => {
                    output += chunk.toString();
                });
                stream.on("end", () => resolve(output.trim()));
            });
        });
    }
    listFiles(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            const output = yield this.execInContainer(roomId, "ls /workspace");
            return output ? output.split("\n") : [];
        });
    }
    readFile(roomId, filename) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.execInContainer(roomId, `cat /workspace/${filename}`);
        });
    }
    writeFile(roomId, filename, content) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.execInContainer(roomId, `echo ${JSON.stringify(content)} > /workspace/${filename}`);
        });
    }
    deleteFile(roomId, filename) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.execInContainer(roomId, `rm /workspace/${filename}`);
        });
    }
}
exports.DockerManager = DockerManager;
