import Docker from "dockerode";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { webSocketServiceInstance } from "..";

export interface ContainerOptions {
  image: string;
  roomId: string;
  exposedPort?: number;
  envVars?: string[];
}

export type FileType = "file" | "folder" | "symlink" | "executable";

export interface FileNode {
  name: string;
  path: string;
  type: FileType;
  children?: FileNode[];
}
export class DockerManager {
  private docker: Docker;
  public activeContainers: { [roomId: string]: string };
  private roomFileTrees: Map<string, FileNode[]>;
  private networkName: string = "cloud_ide_network";
  private nginxContainer: Docker.Container | null = null;

  constructor() {
    this.roomFileTrees = new Map();
    this.docker = new Docker();
    this.activeContainers = {};
    this.initializeNginxProxy();
  }

  private async initializeNginxProxy() {
    try {
      // Check if network exists before creating
      const networks = await this.docker.listNetworks();
      const networkExists = networks.some((n) => n.Name === this.networkName);
      if (!networkExists) {
        await this.docker.createNetwork({
          Name: this.networkName,
          Driver: "bridge",
        });
        console.log(`✅ Created network '${this.networkName}'`);
      } else {
        console.log(`✅ Using existing network '${this.networkName}'`);
      }

      const containers = await this.docker.listContainers({ all: true });
      const nginxExists = containers.find((c) => c.Names.includes("/nginx_proxy"));

      if (!nginxExists) {
        await this.startNginxContainer();
      } else {
        this.nginxContainer = this.docker.getContainer(nginxExists.Id);
        // Ensure Nginx is running
        const nginxInfo = await this.nginxContainer.inspect();
        if (!nginxInfo.State.Running) {
          await this.nginxContainer.start();
          console.log("✅ Restarted existing Nginx proxy container");
        } else {
          console.log("✅ Using existing Nginx proxy container");
        }
      }

      await this.updateNginxConfig();
    } catch (error) {
      console.error("❌ Error initializing Nginx proxy:", error);
    }
  }

  private async startNginxContainer() {
    const image = "nginx:latest";
    const nginxConfigPath = path.resolve("nginx.conf");
  
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
    await fs.writeFile(nginxConfigPath, initialConfig);
  
    const images = await this.docker.listImages();
    const imageExists = images.some((img) => img.RepoTags?.includes(image));
    if (!imageExists) {
      console.log(`❌ Image '${image}' not found. Pulling...`);
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, () => resolve());
        });
      });
    }
  
    this.nginxContainer = await this.docker.createContainer({
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
  
    await this.nginxContainer.start();
  
    try {
      const info = await this.nginxContainer.inspect();
      if (!info.State.Running) {
        const logs = await this.nginxContainer.logs({ stdout: true, stderr: true });
        throw new Error(`Nginx failed to start. Logs: ${logs.toString()}`);
      }
      console.log("✅ Nginx proxy started on port 8080");
    } catch (error) {
      console.error("❌ Nginx startup failed:", error);
      throw error;
    }
  }

  private async updateNginxConfig() {
    if (!this.nginxContainer) return;
  
    const containers = await this.docker.listContainers({ all: true });
    const roomContainers = containers.filter((c) =>
      c.Names.some((name) => name.startsWith("/room-"))
    );
  
    const upstreamsAndLocations = await Promise.all(
      roomContainers.map(async (c) => {
        const roomId = c.Names[0].replace("/room-", "").replace("/room-room-", ""); // Handle both cases
        const { processes } = await this.getContainerProcesses(roomId);
        const ports = processes.map((proc) => proc.port);
  
        const upstreams = ports.map((port) => `
      upstream room_${roomId}_port_${port} {
          server room-${roomId}:${port};
      }`).join("\n");
  
        const locations = ports.map((port) => `
      location /room-${roomId}/${port}/ {
          proxy_pass http://room_${roomId}_port_${port}/;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }`).join("\n");
  
        const defaultLocation = ports.length > 0 ? `
      location /room-${roomId}/ {
          proxy_pass http://room_${roomId}_port_${ports[0]}/;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }` : "";
  
        return { upstreams, locations, defaultLocation };
      })
    );
  
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
              return 404 "No room or port specified";
          }
      }
  }
    `;
  
    const nginxConfigPath = path.resolve("nginx.conf");
    await fs.writeFile(nginxConfigPath, config);
    console.log("Generated nginx.conf:", config);
  
    try {
      const nginxContainerId = this.nginxContainer.id;
      const nginxInfo = await this.nginxContainer.inspect();
      if (!nginxInfo.State.Running) {
        await this.nginxContainer.start();
        console.log("✅ Restarted Nginx proxy");
      }
      await this.execInContainerwithID(nginxContainerId, "nginx -s reload");
      console.log("✅ Nginx config reloaded");
    } catch (error) {
      console.error("❌ Failed to reload Nginx:", error);
      await this.nginxContainer?.restart();
      console.log("✅ Restarted Nginx after reload failure");
    }
  }

  async createContainer(
    options: ContainerOptions
  ): Promise<{ containerId: string; hostPort: number }> {
    try {
      const { image, roomId, exposedPort = 8080, envVars = [] } = options;
      const hostPort = await this.getAvailablePort(4000, 5000);
      const workspacePath = path.resolve("storage", roomId);

      await fs.mkdir(workspacePath, { recursive: true });

      const images = await this.docker.listImages();
      const imageExists = images.some((img) => img.RepoTags?.includes(image));

      if (!imageExists) {
        console.log(`❌ Image '${image}' not found. Pulling...`);
        await new Promise<void>((resolve, reject) => {
          this.docker.pull(image, (err: Error, stream: NodeJS.ReadableStream) => {
            if (err) return reject(err);
            this.docker.modem.followProgress(stream, () => resolve());
          });
        });
      }

      const container = await this.docker.createContainer({
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

      await container.start();
      this.activeContainers[roomId] = container.id;
      console.log(`✅ Container started for '${roomId}' on port ${hostPort}`);
      //for tee formation 
      await this.execInContainer(roomId, "apt update && apt install -y lsof grep tree");
      await this.execInContainer(roomId, "apt update && apt install -y socat"); // for exposing ports if not exposed default to nginx 
      await this.updateNginxConfig();

      return { containerId: container.id, hostPort };
    } catch (error: any) {
      console.error("❌ Error creating container:", error.message || error);
      throw error;
    }
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

  public async getActivePorts(containerId: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      // Command for Linux/Mac (Docker)
      const linuxCmd = `docker exec ${containerId} sh -c "lsof -i -P -n | grep LISTEN"`;
  
      // Command for Windows (Docker)
      const windowsCmd = `docker exec ${containerId} lsof -i -P -n | findstr LISTEN`;
  
      // Choose correct command based on OS
      const cmd = process.platform === "win32" ? windowsCmd : linuxCmd;
  
      exec(cmd, (error, stdout, stderr) => {
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
          .filter(Boolean) as string[]; // Remove null values
  
        console.log("Detected Ports:", ports);
        resolve(ports);
      });
    });
  }
  
  public async getContainerProcesses(
    roomId: string
  ): Promise<{
    containerIP: string;
    processes: Array<{ port: number; pid: number; command: string }>;
  }> {
    try {
      // const containerId = this.activeContainers[roomId];
      const container = await this.getContainer(roomId);
      const containerId = container?.id;
      if (!containerId) {
        throw new Error(`No active container found for room ${containerId}`);
      }

      // Get container IP
      const containerIP = await this.getContainerIP(roomId);
      // Get listening processes in the container
      const command = "lsof -i -P -n | grep LISTEN";
      const output = await this.execInContainer(roomId, command);
      // Parse the output to get processes and ports
      const processes = this.parseListeningProcesses(output);
      return { containerIP, processes };
    } catch (error: any) {
      console.error(`❌ Error getting container processes: ${error}`);
      throw error;
    }
  }

  public parseListeningProcesses(
    output: string
  ): Array<{ port: number; pid: number; command: string }> {
    const processes: Array<{ port: number; pid: number; command: string }> = [];

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
  public async monitorPorts(roomId: string, containerId: string) {
    const io = webSocketServiceInstance.io;
    let previousPorts: string[] = [];
  
    setInterval(async () => {
      try {
        const ports = await this.getActivePorts(containerId);
        console.log("Monitoring ports:", ports);
  
        if (ports.length) {
          io.to(roomId).emit("active-ports", { containerId, ports });
  
          const portsChanged =
            ports.length !== previousPorts.length ||
            ports.some((port) => !previousPorts.includes(port)) ||
            previousPorts.some((port) => !ports.includes(port));
  
          if (portsChanged) {
            // Stop old proxies (optional, or let them run)
            for (const oldPort of previousPorts) {
              if (!ports.includes(oldPort)) {
                await this.execInContainer(roomId, `pkill -f "socat.*:${oldPort}"`);
              }
            }
  
            // Start socat for each port
            for (const port of ports) {
              // Forward localhost:port to 0.0.0.0:port
              const socatCmd =`socat TCP-LISTEN:${port},fork,reuseaddr TCP:127.0.0.1:${port} &`;
              await this.execInContainer(roomId, socatCmd);
            }
  
            console.log("Ports changed, updating Nginx...");
            await this.updateNginxConfig();
            previousPorts = [...ports];
          }
        }
      } catch (err) {
        console.error(`Error monitoring ${containerId}:`, err);
      }
    }, 5000);
  }
  public getContainerIP = async (roomId: string) => {
    const containerFromRoomId = await this.getContainer(roomId);
    console.log("conatiner search",containerFromRoomId)
    if (!containerFromRoomId)
      throw new Error("getContainerIP : no countainer with this room ID found");
    const container = this.docker.getContainer(containerFromRoomId?.id);
    const inspect = await container.inspect();
    const networkName = "cloud_ide_network"; // Same network used earlier
    return inspect.NetworkSettings.Networks[networkName]?.IPAddress || "";
    // return inspect.NetworkSettings.IPAddress; // Get the container's internal IP
  };

  async getContainer(roomId: string) {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const found = containers.filter((c) =>
        c.Names.includes(`/room-${roomId}`)
      );
      // console.log("foinfound)
      console.log("found",found)
      if (!found) {
        console.error(`🚨 Container not found for roomId: ${roomId}`);
        return null;
      }
      const container = await this.docker.getContainer(found[0].Id);
      return container;
    } catch (error) {
      // console.error("❌ Error retrieving container:", error);
      return null;
    }
  }

  async removeContainer(roomId: string) {
    try {
      const container = await this.getContainer(roomId);
      if (!container) {
        console.log(`🛑 No container found for roomId: ${roomId}`);
        return;
      }

      console.log(`🛑 Stopping and removing container: ${roomId}`);
      await container.stop();
      await container.remove();
      console.log(`✅ Container removed successfully: ${roomId}`);
    } catch (error: any) {
      console.error("❌ Error removing container:", error.message || error);
    }
  }

  private async getAvailablePort(start: number, end: number): Promise<number> {
    const net = require("net");

    for (let port = start; port <= end; port++) {
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.once("listening", () => {
            server.close(() => resolve());
          });
          server.listen(port);
        });
        return port; // Found an available port
      } catch {
        // Port is in use, try next one
      } finally {
        server.close();
      }
    }

    throw new Error("❌ No available ports found in the range!");
  }

  //helpers
  async execInContainer(roomId: string, command: string): Promise<string> {
    // if(!roomId && !containerId) throw new Error(`no container ID or Room ID provided for execution`)
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`Container for room '${roomId}' not found`);

    const exec = await container.exec({
      Cmd: ["sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});
    let output = "";

    return new Promise((resolve) => {
      stream.on("data", (chunk) => {
        output += chunk.toString();
      });
      stream.on("end", () => resolve(output.trim()));
    });
  }
  async execInContainerwithID(
    containerId: string,
    command: string
  ): Promise<string> {
    try {
      // Directly get the container by its ID
      const container = this.docker.getContainer(containerId);

      // Verify the container exists (this will throw if it doesn’t)
      await container.inspect();

      // Create an exec instance
      const exec = await container.exec({
        Cmd: ["sh", "-c", command],
        AttachStdout: true,
        AttachStderr: true,
      });

      // Start the exec instance
      const stream = await exec.start({ hijack: true, stdin: false });

      let stdout = "";
      let stderr = "";

      return new Promise((resolve, reject) => {
        stream.on("data", (chunk) => {
          const text = chunk.toString();
          // Dockerode multiplexes stdout (1) and stderr (2)
          if (chunk.length > 0 && chunk[0] === 1) {
            stdout += text;
          } else if (chunk.length > 0 && chunk[0] === 2) {
            stderr += text;
          }
        });

        stream.on("end", () => {
          if (stderr) {
            console.error(
              `Exec stderr for container '${containerId}':`,
              stderr
            );
            resolve(stdout.trim()); // Return stdout, stderr logged for debugging
          } else {
            resolve(stdout.trim());
          }
        });

        stream.on("error", (err) => {
          reject(new Error(`Stream error: ${err.message}`));
        });
      });
    } catch (error: any) {
      console.error(
        `Error executing command in container '${containerId}':`,
        error.message
      );
      throw new Error(
        `Failed to execute command in container '${containerId}': ${error.message}`
      );
    }
  }

  async listFiles(roomId: string): Promise<string[]> {
    const output = await this.execInContainer(roomId, "ls /workspace");
    return output ? output.split("\n") : [];
  }
  async readFile(roomId: string, filename: string): Promise<string> {
    return this.execInContainer(roomId, `cat /workspace/${filename}`);
  }
  async writeFile(
    roomId: string,
    filename: string,
    content: string
  ): Promise<void> {
    const escapedContent = content.replace(/'/g, "'\\''"); // Escape single quotes
    await this.execInContainer(
      roomId,
      `printf '%s' '${escapedContent}' > /workspace/${filename}`
    );
  }

  async deleteFile(roomId: string, filename: string): Promise<void> {
    await this.execInContainer(roomId, `rm /workspace/${filename}`);
  }

  // Map stat output to FileType
  private mapFileType(statType: string): FileType {
    if (statType.includes("directory")) return "folder";
    if (statType.includes("symbolic link")) return "symlink";
    if (statType.includes("executable")) return "executable";
    return "file";
  }

  // Build the hierarchical file tree structure
  // Build the hierarchical file tree structure
  private buildTree(paths: { path: string; type: FileType }[]): FileNode[] {
    const tree: Record<string, FileNode> = {}; // Flat object for quick lookups

    paths.forEach(({ path, type }) => {
      const parts = path.split("/").filter(Boolean);
      let parentKey: string | null = null;

      parts.forEach((part, index) => {
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
          tree[parentKey].children = tree[parentKey].children ?? [];

          // Ensure unique child entries
          if (!tree[parentKey]?.children?.some((child) => child.path === key)) {
            tree[parentKey]?.children?.push(tree[key]);
          }
        }

        parentKey = key; // Move deeper in the tree
      });
    });

    return tree["/workspace"] ? [tree["/workspace"]] : []; // Ensure only "workspace" is the root
  }

  // // Get the file tree inside the container
  public async getFileTree(roomId: string): Promise<FileNode[]> {
    const output = await this.execInContainer(
      roomId,
      `find /workspace -exec stat -c "%F %n" {} + | sed 's|//|/|g'`
    );
    if (!output) return [];

    const paths = output
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(.*) (\/workspace.*)$/);
        return match
          ? { path: match[2], type: this.mapFileType(match[1]) }
          : null;
      })
      .filter(
        (entry): entry is { path: string; type: FileType } => entry !== null
      ); // TypeScript type guard

    const fileTree = this.buildTree(paths);
    this.roomFileTrees.set(roomId, fileTree); // Cache the file tree
    return fileTree;
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
  public async updateFileTree(
    roomId: string,
    newTree: FileNode[]
  ): Promise<boolean> {
    try {
      const container = await this.getContainer(roomId);
      if (!container) {
        console.error(`Container ${roomId} not found.`);
        return false;
      }

      const currentTree =
        this.roomFileTrees.get(`/workspace:${roomId}`) ||
        (await this.getFileTree(roomId));
      const { toCreate, toDelete } = diffTrees(currentTree, newTree);

      await this.applyChangesToContainer(roomId, toCreate, toDelete);
      this.roomFileTrees.set(`/workspace:${roomId}`, newTree); // Update cache
      return true;
    } catch (error) {
      console.error("Error updating file tree:", error);
      return false;
    }
  }

  async applyChangesToContainer(
    roomId: string,
    toCreate: string[],
    toDelete: string[]
  ) {
    for (const path of toDelete) {
      await this.execInContainer(roomId, `rm -rf ${path}`);
    }

    for (const path of toCreate) {
      const isFolder = path.endsWith("/");
      await this.execInContainer(
        roomId,
        isFolder ? `mkdir -p ${path}` : `touch ${path}`
      );
    }
  }
}

function diffTrees(currentTree: FileNode[], newTree: FileNode[]) {
  const currentPaths = new Set(flattenTree(currentTree));
  const newPaths = new Set(flattenTree(newTree));

  const toCreate = [...newPaths].filter((p) => !currentPaths.has(p));
  const toDelete = [...currentPaths].filter((p) => !newPaths.has(p));

  return { toCreate, toDelete };
}

function flattenTree(tree: FileNode[]): string[] {
  return tree.reduce<string[]>((acc, node) => {
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
