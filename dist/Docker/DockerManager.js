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
const __1 = require("..");
class DockerManager {
    constructor() {
        this.networkName = "cloud_ide_network";
        this.nginxContainer = null;
        this.getContainerIP = (roomId) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const containerFromRoomId = yield this.getContainer(roomId);
            if (!containerFromRoomId)
                throw new Error("getContainerIP : no countainer with this room ID found");
            const container = this.docker.getContainer(containerFromRoomId === null || containerFromRoomId === void 0 ? void 0 : containerFromRoomId.id);
            const inspect = yield container.inspect();
            const networkName = "cloud_ide_network"; // Same network used earlier
            return ((_a = inspect.NetworkSettings.Networks[networkName]) === null || _a === void 0 ? void 0 : _a.IPAddress) || "";
            // return inspect.NetworkSettings.IPAddress; // Get the container's internal IP
        });
        this.roomFileTrees = new Map();
        this.docker = new dockerode_1.default();
        this.activeContainers = {};
        this.initializeNginxProxy();
    }
    initializeNginxProxy() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Check if network exists before creating
                const networks = yield this.docker.listNetworks();
                const networkExists = networks.some((n) => n.Name === this.networkName);
                if (!networkExists) {
                    yield this.docker.createNetwork({
                        Name: this.networkName,
                        Driver: "bridge",
                    });
                    console.log(`✅ Created network '${this.networkName}'`);
                }
                else {
                    console.log(`✅ Using existing network '${this.networkName}'`);
                }
                const containers = yield this.docker.listContainers({ all: true });
                const nginxExists = containers.find((c) => c.Names.includes("/nginx_proxy"));
                if (!nginxExists) {
                    yield this.startNginxContainer();
                }
                else {
                    this.nginxContainer = this.docker.getContainer(nginxExists.Id);
                    // Ensure Nginx is running
                    const nginxInfo = yield this.nginxContainer.inspect();
                    if (!nginxInfo.State.Running) {
                        yield this.nginxContainer.start();
                        console.log("✅ Restarted existing Nginx proxy container");
                    }
                    else {
                        console.log("✅ Using existing Nginx proxy container");
                    }
                }
                yield this.updateNginxConfig();
            }
            catch (error) {
                console.error("❌ Error initializing Nginx proxy:", error);
            }
        });
    }
    startNginxContainer() {
        return __awaiter(this, void 0, void 0, function* () {
            const image = "nginx:latest";
            const nginxConfigPath = path_1.default.resolve("nginx.conf");
            const initialConfig = `
  worker_processes 1;
  events {
      worker_connections 1024;
  }
  http {
      server {
          listen 80;
          location / {
              return 200 "Nginx proxy is running";
          }
      }
  }
    `;
            yield promises_1.default.writeFile(nginxConfigPath, initialConfig);
            const images = yield this.docker.listImages();
            const imageExists = images.some((img) => { var _a; return (_a = img.RepoTags) === null || _a === void 0 ? void 0 : _a.includes(image); });
            if (!imageExists) {
                console.log(`❌ Image '${image}' not found. Pulling...`);
                yield new Promise((resolve, reject) => {
                    this.docker.pull(image, (err, stream) => {
                        if (err)
                            return reject(err);
                        this.docker.modem.followProgress(stream, () => resolve());
                    });
                });
            }
            this.nginxContainer = yield this.docker.createContainer({
                Image: image,
                name: "nginx_proxy",
                ExposedPorts: { "80/tcp": {} },
                Cmd: ["nginx", "-g", "daemon off;"],
                HostConfig: {
                    PortBindings: { "80/tcp": [{ HostPort: "8080" }] },
                    Binds: [`${nginxConfigPath}:/etc/nginx/nginx.conf:ro`],
                    NetworkMode: this.networkName,
                },
            });
            yield this.nginxContainer.start();
            try {
                const info = yield this.nginxContainer.inspect();
                if (!info.State.Running) {
                    const logs = yield this.nginxContainer.logs({ stdout: true, stderr: true });
                    throw new Error(`Nginx failed to start. Logs: ${logs.toString()}`);
                }
                console.log("✅ Nginx proxy started on port 8080");
            }
            catch (error) {
                console.error("❌ Nginx startup failed:", error);
                throw error;
            }
        });
    }
    updateNginxConfig() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (!this.nginxContainer)
                return;
            const containers = yield this.docker.listContainers({ all: true });
            const roomContainers = containers.filter((c) => c.Names.some((name) => name.startsWith("/room-")));
            const upstreamsAndLocations = yield Promise.all(roomContainers.map((c) => __awaiter(this, void 0, void 0, function* () {
                const roomId = c.Names[0].replace("/room-", "");
                const { processes } = yield this.getContainerProcesses(roomId);
                const upstreams = processes.map((proc) => `
      upstream room_${roomId}_port_${proc.port} {
          server room-${roomId}:${proc.port};
      }`).join("\n");
                const locations = processes.map((proc) => `
      location /room-${roomId}/${proc.port}/ {
          proxy_pass http://room_${roomId}_port_${proc.port}/;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }`).join("\n");
                const defaultLocation = processes.length > 0 ? `
      location /room-${roomId}/ {
          proxy_pass http://room_${roomId}_port_${processes[0].port}/;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }` : "";
                return { upstreams, locations, defaultLocation };
            })));
            const config = `
  worker_processes 1;
  events {
      worker_connections 1024;
  }
  http {
      ${upstreamsAndLocations.map((item) => item.upstreams).join("\n")}
  
      server {
          listen 80;
  
          ${upstreamsAndLocations.map((item) => item.defaultLocation + item.locations).join("\n")}
  
          location / {
              return 404;
          }
      }
  }
    `;
            const nginxConfigPath = path_1.default.resolve("nginx.conf");
            yield promises_1.default.writeFile(nginxConfigPath, config);
            try {
                const nginxContainerId = this.nginxContainer.id;
                const nginxInfo = yield this.nginxContainer.inspect();
                if (!nginxInfo.State.Running) {
                    yield this.nginxContainer.start();
                    console.log("✅ Restarted Nginx proxy for config reload");
                }
                yield this.execInContainerwithID(nginxContainerId, "nginx -s reload");
                console.log("✅ Nginx config updated and reloaded");
            }
            catch (error) {
                console.error("❌ Failed to reload Nginx:", error);
                yield ((_a = this.nginxContainer) === null || _a === void 0 ? void 0 : _a.restart());
                console.log("✅ Restarted Nginx after reload failure");
            }
        });
    }
    createContainer(options) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { image, roomId, exposedPort = 8080, envVars = [] } = options;
                const hostPort = yield this.getAvailablePort(4000, 5000);
                const workspacePath = path_1.default.resolve("storage", roomId);
                yield promises_1.default.mkdir(workspacePath, { recursive: true });
                const images = yield this.docker.listImages();
                const imageExists = images.some((img) => { var _a; return (_a = img.RepoTags) === null || _a === void 0 ? void 0 : _a.includes(image); });
                if (!imageExists) {
                    console.log(`❌ Image '${image}' not found. Pulling...`);
                    yield new Promise((resolve, reject) => {
                        this.docker.pull(image, (err, stream) => {
                            if (err)
                                return reject(err);
                            this.docker.modem.followProgress(stream, () => resolve());
                        });
                    });
                }
                const container = yield this.docker.createContainer({
                    Image: image,
                    name: `room-${roomId}`,
                    Tty: true,
                    OpenStdin: true,
                    AttachStdin: true,
                    AttachStdout: true,
                    AttachStderr: true,
                    Env: envVars,
                    ExposedPorts: { [`${exposedPort}/tcp`]: {} },
                    HostConfig: {
                        PortBindings: {
                            [`${exposedPort}/tcp`]: [{ HostPort: `${hostPort}` }],
                        },
                        Binds: [`${workspacePath}:/workspace`],
                        Privileged: false,
                        AutoRemove: true,
                        NetworkMode: this.networkName,
                    },
                });
                yield container.start();
                this.activeContainers[roomId] = container.id;
                console.log(`✅ Container started for '${roomId}' on port ${hostPort}`);
                //for tee formation 
                yield this.execInContainer(roomId, "apt update && apt install -y lsof grep tree");
                yield this.execInContainer(roomId, "apt update && apt install -y socat"); // for exposing ports if not exposed default to nginx 
                yield this.updateNginxConfig();
                return { containerId: container.id, hostPort };
            }
            catch (error) {
                console.error("❌ Error creating container:", error.message || error);
                throw error;
            }
        });
    }
    // Assuming this
    // public async getActivePorts(containerId: string) {
    //   return new Promise((resolve, reject) => {
    //     const cmd = `docker exec ${containerId}  sh -c "lsof -i -P -n | grep LISTEN"`; //for docker🐳
    //     // const cmd = `docker exec ${containerId} lsof -i -P -n | findstr LISTEN`; // for windows🪟
    //     exec(cmd, (error, stdout, stderr) => {
    //       if (error) {
    //         console.log(error);
    //         return reject(stderr);
    //       }
    //       const ports = stdout
    //         .split("\n")
    //         .map((line) => line.match(/:(\d+)/)?.[1])
    //         .filter(Boolean);
    //       resolve(ports);
    //     });
    //   });
    // }
    getActivePorts(containerId) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                // Command for Linux/Mac (Docker)
                const linuxCmd = `docker exec ${containerId} sh -c "lsof -i -P -n | grep LISTEN"`;
                // Command for Windows (Docker)
                const windowsCmd = `docker exec ${containerId} lsof -i -P -n | findstr LISTEN`;
                // Choose correct command based on OS
                const cmd = process.platform === "win32" ? windowsCmd : linuxCmd;
                (0, child_process_1.exec)(cmd, (error, stdout, stderr) => {
                    if (error) {
                        console.error("Error fetching active ports:", error);
                        return reject(stderr);
                    }
                    const ports = stdout
                        .split("\n")
                        .map((line) => {
                        const match = line.match(/:(\d+)\s+\(LISTEN\)/);
                        return match ? match[1] : null;
                    })
                        .filter(Boolean); // Remove null values
                    console.log("Detected Ports:", ports);
                    resolve(ports);
                });
            });
        });
    }
    getContainerProcesses(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // const containerId = this.activeContainers[roomId];
                const container = yield this.getContainer(roomId);
                const containerId = container === null || container === void 0 ? void 0 : container.id;
                if (!containerId) {
                    throw new Error(`No active container found for room ${containerId}`);
                }
                // Get container IP
                const containerIP = yield this.getContainerIP(roomId);
                // Get listening processes in the container
                const command = "lsof -i -P -n | grep LISTEN";
                const output = yield this.execInContainer(roomId, command);
                // Parse the output to get processes and ports
                const processes = this.parseListeningProcesses(output);
                return { containerIP, processes };
            }
            catch (error) {
                console.error(`❌ Error getting container processes: ${error}`);
                throw error;
            }
        });
    }
    parseListeningProcesses(output) {
        const processes = [];
        // Split output by lines
        const lines = output.split("\n").filter((line) => line.trim() !== "");
        // Parse each line to extract process and port info
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 9) {
                const command = parts[0];
                const pid = parseInt(parts[1], 10);
                // Extract port from address (format: *:PORT or IP:PORT)
                const addressPart = parts[8];
                const portMatch = addressPart.match(/:(\d+)$/);
                if (portMatch && portMatch[1]) {
                    const port = parseInt(portMatch[1], 10);
                    processes.push({ port, pid, command });
                }
            }
        }
        return processes;
    }
    monitorPorts(roomId, containerId) {
        return __awaiter(this, void 0, void 0, function* () {
            const io = __1.webSocketServiceInstance.io;
            let previousPorts = [];
            setInterval(() => __awaiter(this, void 0, void 0, function* () {
                try {
                    const ports = yield this.getActivePorts(containerId);
                    console.log("Monitoring ports:", ports);
                    if (ports.length) {
                        io.to(roomId).emit("active-ports", { containerId, ports });
                        const portsChanged = ports.length !== previousPorts.length ||
                            ports.some((port) => !previousPorts.includes(port)) ||
                            previousPorts.some((port) => !ports.includes(port));
                        if (portsChanged) {
                            // Stop old proxies (optional, or let them run)
                            for (const oldPort of previousPorts) {
                                if (!ports.includes(oldPort)) {
                                    yield this.execInContainer(roomId, `pkill -f "socat.*:${oldPort}"`);
                                }
                            }
                            // Start socat for each port
                            for (const port of ports) {
                                // Forward localhost:port to 0.0.0.0:port
                                const socatCmd = `socat TCP-LISTEN:${port},fork,reuseaddr TCP:127.0.0.1:${port} &`;
                                yield this.execInContainer(roomId, socatCmd);
                            }
                            console.log("Ports changed, updating Nginx...");
                            yield this.updateNginxConfig();
                            previousPorts = [...ports];
                        }
                    }
                }
                catch (err) {
                    console.error(`Error monitoring ${containerId}:`, err);
                }
            }), 5000);
        });
    }
    getContainer(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const containers = yield this.docker.listContainers({ all: true });
                const found = containers.filter((c) => c.Names.includes(`/room-${roomId}`));
                // console.log("found",found)
                if (!found) {
                    console.error(`🚨 Container not found for roomId: ${roomId}`);
                    return null;
                }
                const container = yield this.docker.getContainer(found[0].Id);
                return container;
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
            // if(!roomId && !containerId) throw new Error(`no container ID or Room ID provided for execution`)
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
    execInContainerwithID(containerId, command) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Directly get the container by its ID
                const container = this.docker.getContainer(containerId);
                // Verify the container exists (this will throw if it doesn’t)
                yield container.inspect();
                // Create an exec instance
                const exec = yield container.exec({
                    Cmd: ["sh", "-c", command],
                    AttachStdout: true,
                    AttachStderr: true,
                });
                // Start the exec instance
                const stream = yield exec.start({ hijack: true, stdin: false });
                let stdout = "";
                let stderr = "";
                return new Promise((resolve, reject) => {
                    stream.on("data", (chunk) => {
                        const text = chunk.toString();
                        // Dockerode multiplexes stdout (1) and stderr (2)
                        if (chunk.length > 0 && chunk[0] === 1) {
                            stdout += text;
                        }
                        else if (chunk.length > 0 && chunk[0] === 2) {
                            stderr += text;
                        }
                    });
                    stream.on("end", () => {
                        if (stderr) {
                            console.error(`Exec stderr for container '${containerId}':`, stderr);
                            resolve(stdout.trim()); // Return stdout, stderr logged for debugging
                        }
                        else {
                            resolve(stdout.trim());
                        }
                    });
                    stream.on("error", (err) => {
                        reject(new Error(`Stream error: ${err.message}`));
                    });
                });
            }
            catch (error) {
                console.error(`Error executing command in container '${containerId}':`, error.message);
                throw new Error(`Failed to execute command in container '${containerId}': ${error.message}`);
            }
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
            const escapedContent = content.replace(/'/g, "'\\''"); // Escape single quotes
            yield this.execInContainer(roomId, `printf '%s' '${escapedContent}' > /workspace/${filename}`);
        });
    }
    deleteFile(roomId, filename) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.execInContainer(roomId, `rm /workspace/${filename}`);
        });
    }
    // Map stat output to FileType
    mapFileType(statType) {
        if (statType.includes("directory"))
            return "folder";
        if (statType.includes("symbolic link"))
            return "symlink";
        if (statType.includes("executable"))
            return "executable";
        return "file";
    }
    // Build the hierarchical file tree structure
    // Build the hierarchical file tree structure
    buildTree(paths) {
        const tree = {}; // Flat object for quick lookups
        paths.forEach(({ path, type }) => {
            const parts = path.split("/").filter(Boolean);
            let parentKey = null;
            parts.forEach((part, index) => {
                var _a, _b, _c, _d, _e;
                const isLeaf = index === parts.length - 1;
                const key = "/" + parts.slice(0, index + 1).join("/");
                // Ensure the current node exists
                if (!tree[key]) {
                    tree[key] = {
                        name: part,
                        path: key,
                        type: isLeaf ? type : "folder",
                        children: isLeaf ? undefined : [],
                    };
                }
                // Handle parent-child relationships safely
                if (parentKey !== null) {
                    if (!tree[parentKey]) {
                        tree[parentKey] = {
                            name: parentKey.split("/").pop() || "",
                            path: parentKey,
                            type: "folder",
                            children: [],
                        };
                    }
                    // Ensure children array is initialized
                    tree[parentKey].children = (_a = tree[parentKey].children) !== null && _a !== void 0 ? _a : [];
                    // Ensure unique child entries
                    if (!((_c = (_b = tree[parentKey]) === null || _b === void 0 ? void 0 : _b.children) === null || _c === void 0 ? void 0 : _c.some((child) => child.path === key))) {
                        (_e = (_d = tree[parentKey]) === null || _d === void 0 ? void 0 : _d.children) === null || _e === void 0 ? void 0 : _e.push(tree[key]);
                    }
                }
                parentKey = key; // Move deeper in the tree
            });
        });
        return tree["/workspace"] ? [tree["/workspace"]] : []; // Ensure only "workspace" is the root
    }
    // // Get the file tree inside the container
    getFileTree(roomId) {
        return __awaiter(this, void 0, void 0, function* () {
            const output = yield this.execInContainer(roomId, `find /workspace -exec stat -c "%F %n" {} + | sed 's|//|/|g'`);
            if (!output)
                return [];
            const paths = output
                .split("\n")
                .map((line) => {
                const match = line.trim().match(/^(.*) (\/workspace.*)$/);
                return match
                    ? { path: match[2], type: this.mapFileType(match[1]) }
                    : null;
            })
                .filter((entry) => entry !== null); // TypeScript type guard
            const fileTree = this.buildTree(paths);
            this.roomFileTrees.set(roomId, fileTree); // Cache the file tree
            return fileTree;
        });
    }
    // public async updateFileTree(
    //   roomId: string,
    //   newTree: FileNode[]
    // ): Promise<boolean> {
    //   try {
    //     const container = this.docker.getContainer(roomId);
    //     if (!container) {
    //       console.error(`Container ${roomId} not found.`);
    //       return false;
    //     }
    //     // Fetch existing file structure
    //     const currentTree = await this.getFileTree(roomId);
    //     // Compare currentTree vs newTree and determine changes
    //     const { toCreate, toDelete } = diffTrees(currentTree, newTree);
    //     // Apply changes inside container
    //     await this.applyChangesToContainer(roomId, toCreate, toDelete);
    //     return true;
    //   } catch (error) {
    //     console.error("Error updating file tree:", error);
    //     return false;
    //   }
    // }
    updateFileTree(roomId, newTree) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const container = yield this.getContainer(roomId);
                if (!container) {
                    console.error(`Container ${roomId} not found.`);
                    return false;
                }
                const currentTree = this.roomFileTrees.get(`/workspace:${roomId}`) ||
                    (yield this.getFileTree(roomId));
                const { toCreate, toDelete } = diffTrees(currentTree, newTree);
                yield this.applyChangesToContainer(roomId, toCreate, toDelete);
                this.roomFileTrees.set(`/workspace:${roomId}`, newTree); // Update cache
                return true;
            }
            catch (error) {
                console.error("Error updating file tree:", error);
                return false;
            }
        });
    }
    applyChangesToContainer(roomId, toCreate, toDelete) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const path of toDelete) {
                yield this.execInContainer(roomId, `rm -rf ${path}`);
            }
            for (const path of toCreate) {
                const isFolder = path.endsWith("/");
                yield this.execInContainer(roomId, isFolder ? `mkdir -p ${path}` : `touch ${path}`);
            }
        });
    }
}
exports.DockerManager = DockerManager;
function diffTrees(currentTree, newTree) {
    const currentPaths = new Set(flattenTree(currentTree));
    const newPaths = new Set(flattenTree(newTree));
    const toCreate = [...newPaths].filter((p) => !currentPaths.has(p));
    const toDelete = [...currentPaths].filter((p) => !newPaths.has(p));
    return { toCreate, toDelete };
}
function flattenTree(tree) {
    return tree.reduce((acc, node) => {
        acc.push(node.path);
        if (node.children) {
            acc.push(...flattenTree(node.children));
        }
        return acc;
    }, []);
}
//! old code her
// private buildTree(paths: string[]): any[] {
//   const tree: any = {};
//   paths.forEach((filePath) => {
//     const parts = filePath.split("/").filter((p) => p); // Split into parts
//     let current = tree;
//     parts.forEach((part, index) => {
//       if (!current[part]) {
//         current[part] = {
//           name: part,
//           path: "/" + parts.slice(0, index + 1).join("/"),
//           type: index === parts.length - 1 ? "file" : "folder",
//           children: {},
//         };
//       }
//       current = current[part].children;
//     });
//   });
//   // Convert to an array
//   function convertToArray(obj: any): any[] {
//     return Object.values(obj).map((value: any) => ({
//       name: value.name,
//       path: value.path,
//       type: value.type,
//       children:
//         value.type === "folder" ? convertToArray(value.children) : undefined,
//     }));
//   }
//   return convertToArray(tree);
// }
// async getFileTree(
//   roomId: string
// ): Promise<
//   { name: string; path: string; type: "file" | "folder"; children?: any[] }[]
// > {
//   const output = await this.execInContainer(
//     roomId,
//     "find /workspace -type f -o -type d"
//   );
//   if (!output) return [];
//   // Split lines and remove any weird characters
//   const paths = output
//     .split("\n")
//     .map((p) => p.trim())
//     .filter((p) => p.startsWith("/workspace")); // Ensure valid paths
//   console.log(this.buildTree(paths))
//   return this.buildTree(paths);
// }
