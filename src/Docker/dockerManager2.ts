// import Docker from "dockerode";
// import path from "path";
// import fs from "fs/promises";
// import { exec } from "child_process";
// import { promisify } from "util";
// import { FileSystemService, FileNode, FileType } from "./fileSystemService";
// import { WebSocketService } from "../Websocket/WebsocketService";
// import { webSocketServiceInstance } from "..";

// const execAsync = promisify(exec);

// export interface ContainerOptions {
//   image: string;
//   roomId: string;
//   exposedPort?: number;
//   envVars?: string[];
// }

// export class DockerManager {
//   public docker: Docker;
//   private activeContainers: Record<string, string>;
//   private roomFileTrees: Map<string, FileNode[]>;
//   private networkName = "cloud_ide_network";
//   private nginxContainer: Docker.Container | null = null;
//   public fileSystemService: FileSystemService;
//   // private wsservice:WebSocketService;

//   constructor() {
//     this.docker = new Docker();
//     this.activeContainers = {};
//     this.roomFileTrees = new Map();
//     this.fileSystemService = new FileSystemService(this.docker);
//     this.initializeNginxProxy().catch((err) =>
//       console.error("Nginx init failed:", err)
//     );
//     // this.wsService = new WebSocketService(htt);
//   }

//   private async initializeNginxProxy(): Promise<void> {
//     const networks = await this.docker.listNetworks();
//     if (!networks.some((n) => n.Name === this.networkName)) {
//       await this.docker.createNetwork({
//         Name: this.networkName,
//         Driver: "bridge",
//       });
//       console.log(`✅ Created network '${this.networkName}'`);
//     }

//     const containers = await this.docker.listContainers({ all: true });
//     const nginxContainer = containers.find((c) =>
//       c.Names.includes("/nginx_proxy")
//     );

//     if (!nginxContainer) {
//       await this.startNginxContainer();
//     } else {
//       this.nginxContainer = this.docker.getContainer(nginxContainer.Id);
//       const info = await this.nginxContainer.inspect();
//       if (!info.State.Running) {
//         await this.nginxContainer.start();
//         console.log("✅ Restarted Nginx proxy");
//       }
//     }

//     await this.updateNginxConfig();
//   }

//   private async startNginxContainer(): Promise<void> {
//     const nginxConfigPath = path.resolve("nginx.conf");
//     await fs.writeFile(
//       nginxConfigPath,
//       `
// worker_processes 1;
// events { worker_connections 1024; }
// http {
//   server {
//     listen 80;
//     location / { return 200 "Nginx proxy running"; }
//   }
// }`
//     );

//     this.nginxContainer = await this.docker.createContainer({
//       Image: "nginx:latest",
//       name: "nginx_proxy",
//       ExposedPorts: { "80/tcp": {} },
//       HostConfig: {
//         PortBindings: { "80/tcp": [{ HostPort: "8080" }] },
//         Binds: [`${nginxConfigPath}:/etc/nginx/nginx.conf:ro`],
//         NetworkMode: this.networkName,
//       },
//     });

//     await this.nginxContainer.start();
//     console.log("✅ Nginx proxy started on port 8080");
//   }

//   private async updateNginxConfig(): Promise<void> {
//     if (!this.nginxContainer) return;
  
//     const containers = await this.docker.listContainers({ all: true });
//     const roomContainers = containers.filter((c) =>
//       c.Names.some((n) => n.startsWith("/room-"))
//     );
  
//     const configParts = await Promise.all(
//       roomContainers.map(async (c) => {
//         const roomId = c.Names[0].replace(/^\/room-/, "");
//         const { processes } = await this.getContainerProcesses(roomId);
//         const ports = processes.map((p) => p.port);
  
//         const upstreams = ports
//           .map(
//             (port) => `
//   upstream room_${roomId}_port_${port} {
//     server room-${roomId}:${port};
//   }`
//           )
//           .join("\n");
  
//         const locations = ports
//           .map(
//             (port) => `
//         location /room-${roomId}/${port}/ {
//           proxy_pass http://room_${roomId}_port_${port};
//           proxy_http_version 1.1;
//           proxy_set_header Upgrade $http_upgrade;
//           proxy_set_header Connection "upgrade";
//           proxy_set_header Host $host;
//           proxy_set_header X-Real-IP $remote_addr;
//         }`
//           )
//           .join("\n");
  
//         const defaultLocation = ports.length
//           ? `
//         location /room-${roomId}/ {
//           proxy_pass http://room_${roomId}_port_${ports[0]};
//           proxy_http_version 1.1;
//           proxy_set_header Upgrade $http_upgrade;
//           proxy_set_header Connection "upgrade";
//           proxy_set_header Host $host;
//           proxy_set_header X-Real-IP $remote_addr;
//         }`
//           : "";
  
//         return { upstreams, locations, defaultLocation };
//       })
//     );
  
//     const nginxConfigPath = path.resolve("nginx.conf");
//     await fs.writeFile(
//       nginxConfigPath,
//       `
//   worker_processes 1;
//   events { worker_connections 1024; }
//   http {
//   ${configParts.map((p) => p.upstreams).join("\n")}
//     server {
//       listen 80;
//   ${configParts.map((p) => p.defaultLocation + p.locations).join("\n")}
//       location / { return 404 "No room or port specified"; }
//     }
//   }`
//     );
  
//     await this.fileSystemService.execInContainer(
//       this.nginxContainer.id,
//       "nginx -s reload"
//     );
//     console.log("✅ Nginx config reloaded");
//   }

//   async createContainer(
//     options: ContainerOptions
//   ): Promise<{ containerId: string; hostPort: number }> {
//     const { image, roomId, exposedPort = 8080, envVars = [] } = options;
//     const hostPort = await this.getAvailablePort(4000, 5000);
//     const workspacePath = path.resolve("storage", roomId);
    
//     await fs.mkdir(workspacePath, { recursive: true });
    
//     const subpath = `/room-${roomId}/5173/`;
//     const updatedEnvVars = [...envVars, `VITE_BASE_PATH=${subpath}`];
  
//     const container = await this.docker.createContainer({
//       Image: image,
//       name: `room-${roomId}`,
//       Tty: true,
//       OpenStdin: true,
//       Env: updatedEnvVars,
//       ExposedPorts: { [`${exposedPort}/tcp`]: {} },
//       WorkingDir: "/workspace",
//       HostConfig: {
//         PortBindings: {
//           [`${exposedPort}/tcp`]: [{ HostPort: String(hostPort) }],
//         },
//         NetworkMode: this.networkName,
//         AutoRemove: true,
//       },
//     });
  
//     await container.start();
  
//     await this.fileSystemService.execInContainer(
//       container.id,
//       "apt update && apt install -y lsof grep tree socat"
//     );
//     try {
//       await this.updateNginxConfig();
//     } catch (err) {
//       console.error("❌ Error updating NGINX:", err);
//     }
//     return { containerId: container.id, hostPort };
//   }

//   async getActivePorts(containerId: string): Promise<string[]> {
//     const output = await this.fileSystemService.execInContainer(
//       containerId,
//       "lsof -i -P -n | grep LISTEN"
//     );
//     return output
//       .split("\n")
//       .map((line) => line.match(/:(\d+)\s+\(LISTEN\)/)?.[1])
//       .filter((port): port is string => !!port);
//   }

//   async getContainerProcesses(roomId: string): Promise<{
//     containerIP: string;
//     processes: Array<{ port: number; pid: number; command: string }>;
//   }> {
//     const container = await this.getContainer(roomId);
//     if (!container) throw new Error(`No container for room '${roomId}'`);

//     const containerIP = await this.getContainerIP(roomId);
//     const output = await this.fileSystemService.execInContainer(
//       container.id,
//       "lsof -i -P -n | grep LISTEN"
//     );

//     const processes = output
//       .split("\n")
//       .map((line) => {
//         const parts = line.split(/\s+/);
//         if (parts.length < 9) return null;
//         const command = parts[0];
//         const pid = Number(parts[1]);
//         const port = Number(parts[8].match(/:(\d+)$/)?.[1]);
//         return port && pid ? { port, pid, command } : null;
//       })
//       .filter((p): p is { port: number; pid: number; command: string } => !!p);

//     return { containerIP, processes };
//   }
//   async checkHealth(containerId: string, port: number): Promise<boolean> {
//     try {
//       const output = await this.fileSystemService.execInContainer(
//         containerId,
//         `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/health`
//       );
//       console.log("helath", output);
//       return output.trim() === "200";
//     } catch (e) {
//       return false;
//     }
//   }

//   // async monitorPorts(roomId: string, containerId: string) {
//   //   console.log(
//   //     `🔍 Starting port monitoring for room: ${roomId}, container: ${containerId}`
//   //   );
//   //   const container = await this.getContainer(roomId);
//   //   if (!container || !container?.id)
//   //     throw new Error("no container found for monitoring");

//   //   const monitor = async () => {
//   //     try {
//   //       const activePorts = await this.getActivePorts(containerId);
//   //       if (activePorts.length > 0) {
//   //         for (let port of activePorts) {
//   //           this.checkHealth(containerId, parseInt(port));
//   //         }
//   //         webSocketServiceInstance.io
//   //           .to(roomId)
//   //           .emit("active-ports", { containerId, ports: activePorts });
//   //         this.updateNginxConfig();
//   //         console.log(`📤 Emitted active-ports for ${roomId}:`, activePorts);
//   //       } else {
//   //         console.log(`ℹ️ No active ports detected for ${roomId}`);
//   //       }
//   //     } catch (error) {
//   //       console.error(`❌ Error monitoring ports for ${roomId}:`, error);
//   //     }
//   //   };

//   //   await monitor();
//   //   const interval = setInterval(monitor, 5000);
//   //   container.wait(() => clearInterval(interval));
//   // }
//   async monitorPorts(roomId: string, containerId: string) {
//     console.log(
//       `🔍 Starting port monitoring for room: ${roomId}, container: ${containerId}`
//     );
  
//     const container = await this.getContainer(roomId);
//     if (!container || !container?.id)
//       throw new Error("No container found for monitoring");
  
//     const monitor = async () => {
//       try {
//         const activePorts = await this.getActivePorts(containerId);
  
//         if (activePorts.length > 0) {
//           for (let port of activePorts) {
//             this.checkHealth(containerId, parseInt(port));
//           }
  
//           // Emit active ports to WebSocket
//           webSocketServiceInstance.io
//             .to(roomId)
//             .emit("active-ports", { containerId, ports: activePorts });
  
//           // Dynamically determine the basePath
//           const basePath = `/room-${roomId}/${activePorts[0]}/`; // Using first port for simplicity
//           // Write basePath to shared env config file inside the container
//           await container.exec({
//             Cmd: [
//               'sh',
//               '-c',
//               `echo '{ "VITE_BASE_PATH": "${basePath}" }' > /etc/cloudide/env.json`
//             ],
//             AttachStdout: true,
//             AttachStderr: true
//           });
  
//           // Optionally update Nginx config (if needed)
//           this.updateNginxConfig();
  
//           console.log(`📤 Emitted active-ports for ${roomId}:`, activePorts);
//         } else {
//           console.log(`ℹ️ No active ports detected for ${roomId}`);
//         }
//       } catch (error) {
//         console.error(`❌ Error monitoring ports for ${roomId}:`, error);
//       }
//     };
  
//     await monitor();
//     const interval = setInterval(monitor, 5000);
//     container.wait(() => clearInterval(interval));
//   }
  

//   async getContainerIP(roomId: string): Promise<string> {
//     const container = await this.getContainer(roomId);
//     if (!container) throw new Error(`No container for room '${roomId}'`);
//     const inspect = await container.inspect();
//     return inspect.NetworkSettings.Networks[this.networkName]?.IPAddress || "";
//   }

//   async getContainer(roomId: string): Promise<Docker.Container | null> {
//     const containers = await this.docker.listContainers({ all: true });
//     const containerInfo = containers.find((c) =>
//       c.Names.includes(`/room-${roomId}`)
//     );
//     return containerInfo ? this.docker.getContainer(containerInfo.Id) : null;
//   }

//   async removeContainer(roomId: string): Promise<void> {
//     const container = await this.getContainer(roomId);
//     if (container) {
//       await container.stop();
//       await container.remove();
//       delete this.activeContainers[roomId];
//       this.roomFileTrees.delete(roomId);
//     }
//   }

//   private async getAvailablePort(start: number, end: number): Promise<number> {
//     const net = require("net");
//     for (let port = start; port <= end; port++) {
//       const server = net.createServer();
//       try {
//         await new Promise<void>((resolve, reject) => {
//           server.once("error", reject);
//           server.once("listening", () => server.close(resolve));
//           server.listen(port);
//         });
//         return port;
//       } catch {
//         continue;
//       }
//     }
//     throw new Error("No available ports");
//   }

//   async listFiles(roomId: string): Promise<string[]> {
//     const output = await this.fileSystemService.execInContainer(
//       this.activeContainers[roomId],
//       "ls /workspace"
//     );
//     return output.split("\n").filter(Boolean);
//   }

//   async readFile(roomId: string, filename: string): Promise<string> {
//     const container = await this.getContainer(roomId);
//     if (!container || !container?.id) throw new Error("not found container");

//     return this.fileSystemService.execInContainer(
//       container?.id,
//       `cat /${filename}`
//     );
//   }

//   async writeFile(
//     roomId: string,
//     filename: string,
//     content: string
//   ): Promise<void> {
//     const container = await this.getContainer(roomId);
//     if (!container || !container?.id) throw new Error("not found container");
//     const escaped = content.replace(/'/g, "'\\''");
//     await this.fileSystemService.execInContainer(
//       // this.activeContainers[roomId],/
//       container?.id,
//       `printf '%s' '${escaped}' > /${filename}`
//     );
//   }

//   async deleteFile(roomId: string, filename: string): Promise<void> {
//     await this.fileSystemService.execInContainer(
//       this.activeContainers[roomId],
//       `rm /workspace/${filename}`
//     );
//   }

//   async getFileTree(roomId: string): Promise<FileNode[]> {
//     const container = await this.getContainer(roomId);
//     if (!container) throw new Error(`No container for room '${roomId}'`);
//     const fileTree = await this.fileSystemService.getFullFileTree(container.id);
//     this.roomFileTrees.set(roomId, fileTree);
//     return fileTree;
//   }

//   async updateFileTree(roomId: string, newTree: FileNode[]): Promise<boolean> {
//     const container = await this.getContainer(roomId);
//     if (!container) return false;

//     const currentTree =
//       this.roomFileTrees.get(roomId) || (await this.getFileTree(roomId));
//     const { toCreate, toDelete } = diffTrees(currentTree, newTree);

//     await this.applyChangesToContainer(container.id, toCreate, toDelete);
//     this.roomFileTrees.set(roomId, newTree);
//     return true;
//   }

//   private async applyChangesToContainer(
//     containerId: string,
//     toCreate: string[],
//     toDelete: string[]
//   ): Promise<void> {
//     for (const path of toDelete) {
//       await this.fileSystemService.execInContainer(
//         containerId,
//         `rm -rf ${path}`
//       );
//     }
//     for (const path of toCreate) {
//       const isFolder = path.endsWith("/");
//       await this.fileSystemService.execInContainer(
//         containerId,
//         isFolder ? `mkdir -p ${path}` : `touch ${path}`
//       );
//     }
//   }
// }

// function diffTrees(
//   currentTree: FileNode[],
//   newTree: FileNode[]
// ): { toCreate: string[]; toDelete: string[] } {
//   const currentPaths = new Set(flattenTree(currentTree));
//   const newPaths = new Set(flattenTree(newTree));
//   return {
//     toCreate: [...newPaths].filter((p) => !currentPaths.has(p)),
//     toDelete: [...currentPaths].filter((p) => !newPaths.has(p)),
//   };
// }

// function flattenTree(tree: FileNode[]): string[] {
//   return tree.reduce<string[]>((acc, node) => {
//     acc.push(node.path);
//     if (node.children) acc.push(...flattenTree(node.children));
//     return acc;
//   }, []);
// }
