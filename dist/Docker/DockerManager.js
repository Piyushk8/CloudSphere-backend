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
const child_process_1 = require("child_process");
const util_1 = require("util");
const fileSystemService_1 = require("./fileSystemService");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class DockerManager {
    constructor() {
        this.networkName = "cloud_ide_network";
        this.nginxContainer = null;
        this.docker = new dockerode_1.default();
        this.activeContainers = {};
        this.roomFileTrees = new Map();
        this.fileSystemService = new fileSystemService_1.FileSystemService(this.docker);
        this.initializeNginxProxy().catch((err) => console.error("Nginx init failed:", err));
    }
    initializeNginxProxy() {
        return __awaiter(this, void 0, void 0, function* () {
            const networks = yield this.docker.listNetworks();
            if (!networks.some((n) => n.Name === this.networkName)) {
                yield this.docker.createNetwork({ Name: this.networkName, Driver: "bridge" });
                console.log(`✅ Created network '${this.networkName}'`);
            }
            const containers = yield this.docker.listContainers({ all: true });
            const nginxContainer = containers.find((c) => c.Names.includes("/nginx_proxy"));
            if (!nginxContainer) {
                yield this.startNginxContainer();
            }
            else {
                this.nginxContainer = this.docker.getContainer(nginxContainer.Id);
                const info = yield this.nginxContainer.inspect();
                if (!info.State.Running) {
                    yield this.nginxContainer.start();
                    console.log("✅ Restarted Nginx proxy");
                }
            }
            yield this.updateNginxConfig();
        });
    }
    startNginxContainer() {
        return __awaiter(this, void 0, void 0, function* () {
            const nginxConfigPath = path_1.default.resolve("nginx.conf");
            yield promises_1.default.writeFile(nginxConfigPath, `
worker_processes 1;
events { worker_connections 1024; }
http {
  server {
    listen 80;
    location / { return 200 "Nginx proxy running"; }
  }
}`);
            this.nginxContainer = yield this.docker.createContainer({
                Image: "nginx:latest",
                name: "nginx_proxy",
                ExposedPorts: { "80/tcp": {} },
                HostConfig: {
                    PortBindings: { "80/tcp": [{ HostPort: "8080" }] },
                    Binds: [`${nginxConfigPath}:/etc/nginx/nginx.conf:ro`],
                    NetworkMode: this.networkName,
                },
            });
            yield this.nginxContainer.start();
            console.log("✅ Nginx proxy started on port 8080");
        });
    }
    updateNginxConfig() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.nginxContainer)
                return;
            const containers = yield this.docker.listContainers({ all: true });
            const roomContainers = containers.filter((c) => c.Names.some((n) => n.startsWith("/room-")));
            const configParts = yield Promise.all(roomContainers.map((c) => __awaiter(this, void 0, void 0, function* () {
                const roomId = c.Names[0].replace(/^\/room-/, "");
                const { processes } = yield this.getContainerProcesses(roomId);
                const ports = processes.map((p) => p.port);
                const upstreams = ports
                    .map((port) => `
upstream room_${roomId}_port_${port} {
  server room-${roomId}:${port};
}`)
                    .join("\n");
                const locations = ports
                    .map((port) => `
location /room-${roomId}/${port}/ {
  proxy_pass http://room_${roomId}_port_${port}/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}`)
                    .join("\n");
                const defaultLocation = ports.length
                    ? `
location /room-${roomId}/ {
  proxy_pass http://room_${roomId}_port_${ports[0]}/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}`
                    : "";
                return { upstreams, locations, defaultLocation };
            })));
            const nginxConfigPath = path_1.default.resolve("nginx.conf");
            yield promises_1.default.writeFile(nginxConfigPath, `
worker_processes 1;
events { worker_connections 1024; }
http {
${configParts.map((p) => p.upstreams).join("\n")}
  server {
    listen 80;
${configParts.map((p) => p.defaultLocation + p.locations).join("\n")}
    location / { return 404 "No room or port specified"; }
  }
}`);
            yield this.fileSystemService.execInContainer(this.nginxContainer.id, "nginx -s reload");
            console.log("✅ Nginx config reloaded");
        });
    }
    createContainer(options) {
        return __awaiter(this, void 0, void 0, function* () {
            const { image, roomId, exposedPort = 8080, envVars = [] } = options;
            const hostPort = yield this.getAvailablePort(4000, 5000);
            const workspacePath = path_1.default.resolve("storage", roomId);
            yield promises_1.default.mkdir(workspacePath, { recursive: true });
            const container = yield this.docker.createContainer({
                Image: image,
                name: `room-${roomId}`,
                Tty: true,
                OpenStdin: true,
                Env: envVars,
                ExposedPorts: { [`${exposedPort}/tcp`]: {} },
                HostConfig: {
                    PortBindings: { [`${exposedPort}/tcp`]: [{ HostPort: String(hostPort) }] },
                    Binds: [`${workspacePath}:/workspace`],
                    NetworkMode: this.networkName,
                    AutoRemove: true,
                },
            });
            yield container.start();
            this.activeContainers[roomId] = container.id;
            yield this.fileSystemService.execInContainer(container.id, "apt update && apt install -y lsof grep tree socat");
            yield this.updateNginxConfig();
            return { containerId: container.id, hostPort };
        });
    }
    getActivePorts(containerId) {
        return __awaiter(this, void 0, void 0, function* () {
            const output = yield this.fileSystemService.execInContainer(containerId, "lsof -i -P -n | grep LISTEN");
            return output
                .split("\n")
                .map((line) => { var _a; return (_a = line.match(/:(\d+)\s+\(LISTEN\)/)) === null || _a === void 0 ? void 0 : _a[1]; })
                .filter((port) => !!port);
        });
    }
    getContainerProcesses(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            const container = yield this.getContainer(roomId);
            if (!container)
                throw new Error(`No container for room '${roomId}'`);
            const containerIP = yield this.getContainerIP(roomId);
            const output = yield this.fileSystemService.execInContainer(container.id, "lsof -i -P -n | grep LISTEN");
            const processes = output
                .split("\n")
                .map((line) => {
                var _a;
                const parts = line.split(/\s+/);
                if (parts.length < 9)
                    return null;
                const command = parts[0];
                const pid = Number(parts[1]);
                const port = Number((_a = parts[8].match(/:(\d+)$/)) === null || _a === void 0 ? void 0 : _a[1]);
                return port && pid ? { port, pid, command } : null;
            })
                .filter((p) => !!p);
            return { containerIP, processes };
        });
    }
    monitorPorts(roomId, containerId) {
        return __awaiter(this, void 0, void 0, function* () {
            let previousPorts = [];
            setInterval(() => __awaiter(this, void 0, void 0, function* () {
                const ports = yield this.getActivePorts(containerId);
                if (ports.length !== previousPorts.length ||
                    ports.some((p) => !previousPorts.includes(p))) {
                    for (const oldPort of previousPorts) {
                        if (!ports.includes(oldPort)) {
                            yield this.fileSystemService.execInContainer(containerId, `pkill -f "socat.*:${oldPort}"`);
                        }
                    }
                    for (const port of ports) {
                        yield this.fileSystemService.execInContainer(containerId, `socat TCP-LISTEN:${port},fork,reuseaddr TCP:127.0.0.1:${port} &`);
                    }
                    yield this.updateNginxConfig();
                    previousPorts = [...ports];
                }
            }), 5000);
        });
    }
    getContainerIP(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const container = yield this.getContainer(roomId);
            if (!container)
                throw new Error(`No container for room '${roomId}'`);
            const inspect = yield container.inspect();
            return ((_a = inspect.NetworkSettings.Networks[this.networkName]) === null || _a === void 0 ? void 0 : _a.IPAddress) || "";
        });
    }
    getContainer(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            const containers = yield this.docker.listContainers({ all: true });
            const containerInfo = containers.find((c) => c.Names.includes(`/room-${roomId}`));
            return containerInfo ? this.docker.getContainer(containerInfo.Id) : null;
        });
    }
    removeContainer(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            const container = yield this.getContainer(roomId);
            if (container) {
                yield container.stop();
                yield container.remove();
                delete this.activeContainers[roomId];
                this.roomFileTrees.delete(roomId);
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
                        server.once("listening", () => server.close(resolve));
                        server.listen(port);
                    });
                    return port;
                }
                catch (_a) {
                    continue;
                }
            }
            throw new Error("No available ports");
        });
    }
    listFiles(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            const output = yield this.fileSystemService.execInContainer(this.activeContainers[roomId], "ls /workspace");
            return output.split("\n").filter(Boolean);
        });
    }
    readFile(roomId, filename) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.fileSystemService.execInContainer(this.activeContainers[roomId], `cat /workspace/${filename}`);
        });
    }
    writeFile(roomId, filename, content) {
        return __awaiter(this, void 0, void 0, function* () {
            const escaped = content.replace(/'/g, "'\\''");
            yield this.fileSystemService.execInContainer(this.activeContainers[roomId], `printf '%s' '${escaped}' > /workspace/${filename}`);
        });
    }
    deleteFile(roomId, filename) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.fileSystemService.execInContainer(this.activeContainers[roomId], `rm /workspace/${filename}`);
        });
    }
    getFileTree(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            const container = yield this.getContainer(roomId);
            if (!container)
                throw new Error(`No container for room '${roomId}'`);
            const fileTree = yield this.fileSystemService.getFullFileTree(container.id);
            this.roomFileTrees.set(roomId, fileTree);
            return fileTree;
        });
    }
    updateFileTree(roomId, newTree) {
        return __awaiter(this, void 0, void 0, function* () {
            const container = yield this.getContainer(roomId);
            if (!container)
                return false;
            const currentTree = this.roomFileTrees.get(roomId) || (yield this.getFileTree(roomId));
            const { toCreate, toDelete } = diffTrees(currentTree, newTree);
            yield this.applyChangesToContainer(container.id, toCreate, toDelete);
            this.roomFileTrees.set(roomId, newTree);
            return true;
        });
    }
    applyChangesToContainer(containerId, toCreate, toDelete) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const path of toDelete) {
                yield this.fileSystemService.execInContainer(containerId, `rm -rf ${path}`);
            }
            for (const path of toCreate) {
                const isFolder = path.endsWith("/");
                yield this.fileSystemService.execInContainer(containerId, isFolder ? `mkdir -p ${path}` : `touch ${path}`);
            }
        });
    }
}
exports.DockerManager = DockerManager;
function diffTrees(currentTree, newTree) {
    const currentPaths = new Set(flattenTree(currentTree));
    const newPaths = new Set(flattenTree(newTree));
    return {
        toCreate: [...newPaths].filter((p) => !currentPaths.has(p)),
        toDelete: [...currentPaths].filter((p) => !newPaths.has(p)),
    };
}
function flattenTree(tree) {
    return tree.reduce((acc, node) => {
        acc.push(node.path);
        if (node.children)
            acc.push(...flattenTree(node.children));
        return acc;
    }, []);
}
