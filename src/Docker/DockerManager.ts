import Docker from "dockerode";
import path from "path";
import fs from "fs/promises";
import { FileSystemService, FileNode } from "./fileSystemService";
import { webSocketServiceInstance } from "..";
import dotenv from "dotenv";
dotenv.config();

export interface ContainerOptions {
  image: string;
  roomId: string;
  exposedPort?: number;
  envVars?: string[];
}

export class DockerManager {
  public docker: Docker;
  private activeContainers: Record<string, string>;
  private roomFileTrees: Map<string, FileNode[]>;
  private networkName = process.env.NETWORK_NAME || "";
  public fileSystemService: FileSystemService;

  constructor() {
    this.docker = new Docker();
    this.activeContainers = {};
    this.roomFileTrees = new Map();
    this.fileSystemService = new FileSystemService(this.docker);
  }

  
  async createContainer(
    options: ContainerOptions
  ): Promise<{ containerId: string }> {
    const { image, roomId, exposedPort = 8080, envVars = [] } = options;

    const containerName = `room-${roomId}`;
    const host = `${containerName}.localhost`;

    const container = await this.docker.createContainer({
      Image: image,
      name: containerName,
      Tty: true,
      OpenStdin: true,
      Env: envVars,
      ExposedPorts: { [`${exposedPort}/tcp`]: {} },
      WorkingDir: "/workspace",
      HostConfig: {
        Memory: 1024 * 1024 * 1024,
        CpuQuota: 100000,
        CpuPeriod: 100000,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.networkName]: {}, // this.networkName = "traefik-network"
        },
      },
      Labels: {
        "traefik.enable": "true",
        "traefik.docker.network": this.networkName,

        [`traefik.http.routers.${containerName}.rule`]: `Host(\`${host}\`)`,
        [`traefik.http.routers.${containerName}.entrypoints`]: "web",
        [`traefik.http.services.${containerName}.loadbalancer.server.port`]: `${exposedPort}`,
      },
    });

    await container.start();
    this.activeContainers[roomId] = container.id;
    await this.fileSystemService.execInContainer(
      container.id,
      "apt update && apt install -y lsof grep tree socat"
    );

    this.monitorPorts(roomId, container.id);

    return { containerId: container.id };
  }

  async getActivePorts(containerId: string): Promise<string[]> {
    const { output } = await this.fileSystemService.execInContainer(
      containerId,
      "lsof -i -P -n | grep LISTEN"
    );
    return output
      .split("\n")
      .map((line) => line.match(/:(\d+)\s+\(LISTEN\)/)?.[1])
      .filter((port): port is string => !!port);
  }

  async getContainerProcesses(roomId: string): Promise<{
    containerIP: string;
    processes: Array<{ port: number; pid: number; command: string }>;
  }> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);

    const containerIP = await this.getContainerIP(roomId);
    const { output } = await this.fileSystemService.execInContainer(
      container.id,
      "lsof -i -P -n | grep LISTEN"
    );

    const processes = output
      .split("\n")
      .map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length < 9) return null;
        const command = parts[0];
        const pid = Number(parts[1]);
        const port = Number(parts[8].match(/:(\d+)$/)?.[1]);
        return port && pid ? { port, pid, command } : null;
      })
      .filter((p): p is { port: number; pid: number; command: string } => !!p);

    return { containerIP, processes };
  }

  async checkHealth(containerId: string, port: number): Promise<boolean> {
    try {
      const { output } = await this.fileSystemService.execInContainer(
        containerId,
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/health`
      );
      return output.trim() === "200";
    } catch {
      return false;
    }
  }

  async monitorPorts(roomId: string, containerId: string) {
    console.log(
      `🔍 Starting port monitoring for room: ${roomId}, container: ${containerId}`
    );
    const container = await this.getContainer(roomId);
    if (!container) throw new Error("No container found for monitoring");

    const monitor = async () => {
      try {
        const activePorts = await this.getActivePorts(containerId);
        if (activePorts.length > 0) {
          for (const port of activePorts) {
            await this.checkHealth(containerId, parseInt(port));
          }
          webSocketServiceInstance.io
            .to(roomId)
            .emit("active-ports", { containerId, ports: activePorts });
          //! await this.updateNginxConfig();
          console.log(`📤 Emitted active-ports for ${roomId}:`, activePorts);
        }
      } catch (error) {
        console.error(`❌ Error monitoring ports for ${roomId}:`, error);
      }
    };

    await monitor();
    const interval = setInterval(monitor, 5000);
    container.wait(() => clearInterval(interval));
  }

  async getContainerIP(roomId: string): Promise<string> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const inspect = await container.inspect();
    return inspect.NetworkSettings.Networks[this.networkName]?.IPAddress || "";
  }

  async getContainer(roomId: string): Promise<Docker.Container | null> {
    const containers = await this.docker.listContainers({ all: true });
    const containerInfo = containers.find((c) =>
      c.Names.includes(`/room-${roomId}`)
    );
    return containerInfo ? this.docker.getContainer(containerInfo.Id) : null;
  }

  async removeContainer(roomId: string): Promise<void> {
    const container = await this.getContainer(roomId);
    if (container) {
      await container.stop();
      await container.remove();
      delete this.activeContainers[roomId];
      this.roomFileTrees.delete(roomId);
    }
  }

  private async getAvailablePort(start: number, end: number): Promise<number> {
    const net = require("net");
    for (let port = start; port <= end; port++) {
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.once("listening", () => server.close(resolve));
          server.listen(port);
        });
        return port;
      } catch {
        continue;
      }
    }
    throw new Error("No available ports");
  }

  async createFile(roomId: string, filePath: string): Promise<void> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const escapedPath = this.fileSystemService.escapePath(filePath);
    const { exitCode: existsExitCode } =
      await this.fileSystemService.execInContainer(
        container.id,
        `[ -e ${escapedPath} ]`
      );
    if (existsExitCode === 0)
      throw new Error(`File already exists: ${filePath}`);
    const { exitCode } = await this.fileSystemService.execInContainer(
      container.id,
      `touch ${escapedPath}`
    );
    if (exitCode !== 0) throw new Error(`Failed to create file: ${filePath}`);
  }

  async createFolder(roomId: string, folderPath: string): Promise<void> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const escapedPath = this.fileSystemService.escapePath(folderPath);
    const { exitCode: existsExitCode } =
      await this.fileSystemService.execInContainer(
        container.id,
        `[ -e ${escapedPath} ]`
      );
    if (existsExitCode === 0)
      throw new Error(`Folder already exists: ${folderPath}`);
    const { exitCode } = await this.fileSystemService.execInContainer(
      container.id,
      `mkdir ${escapedPath}`
    );
    if (exitCode !== 0)
      throw new Error(`Failed to create folder: ${folderPath}`);
  }

  async deletePath(roomId: string, path: string): Promise<void> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const escapedPath = this.fileSystemService.escapePath(path);
    const { exitCode: existsExitCode } =
      await this.fileSystemService.execInContainer(
        container.id,
        `[ -e ${escapedPath} ]`
      );
    if (existsExitCode !== 0) throw new Error(`Path does not exist: ${path}`);
    const { exitCode } = await this.fileSystemService.execInContainer(
      container.id,
      `rm -rf ${escapedPath}`
    );
    if (exitCode !== 0) throw new Error(`Failed to delete path: ${path}`);
  }

  async renamePath(
    roomId: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const escapedOldPath = this.fileSystemService.escapePath(oldPath);
    const escapedNewPath = this.fileSystemService.escapePath(newPath);
    const { exitCode: oldExists } =
      await this.fileSystemService.execInContainer(
        container.id,
        `[ -e ${escapedOldPath} ]`
      );
    if (oldExists !== 0) throw new Error(`Old path does not exist: ${oldPath}`);
    const { exitCode: newExists } =
      await this.fileSystemService.execInContainer(
        container.id,
        `[ -e ${escapedNewPath} ]`
      );
    if (newExists === 0) throw new Error(`New path already exists: ${newPath}`);
    const { exitCode } = await this.fileSystemService.execInContainer(
      container.id,
      `агатоmv ${escapedOldPath} ${escapedNewPath}`
    );
    if (exitCode !== 0)
      throw new Error(`Failed to rename path: ${oldPath} to ${newPath}`);
  }

  async readFile(roomId: string, filename: string): Promise<string> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const { output } = await this.fileSystemService.execInContainer(
      container.id,
      `cat ${this.fileSystemService.escapePath(`/workspace/${filename}`)}`
    );
    return output;
  }

  async writeFile(
    roomId: string,
    filename: string,
    content: string
  ): Promise<void> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const escapedContent = content.replace(/'/g, "'\\''");
    const { exitCode } = await this.fileSystemService.execInContainer(
      container.id,
      `printf '%s' '${escapedContent}' > ${this.fileSystemService.escapePath(
        `/workspace/${filename}`
      )}`
    );
    if (exitCode !== 0) throw new Error(`Failed to write file: ${filename}`);
  }

  async deleteFile(roomId: string, filename: string): Promise<void> {
    await this.deletePath(roomId, `/workspace/${filename}`);
  }

  async getFileTree(roomId: string): Promise<FileNode[]> {
    const container = await this.getContainer(roomId);
    if (!container) throw new Error(`No container for room '${roomId}'`);
    const fileTree = await this.fileSystemService.getFullFileTree(container.id);
    this.roomFileTrees.set(roomId, fileTree);
    return fileTree;
  }

  async updateFileTree(roomId: string, newTree: FileNode[]): Promise<boolean> {
    const container = await this.getContainer(roomId);
    if (!container) return false;

    const currentTree =
      this.roomFileTrees.get(roomId) || (await this.getFileTree(roomId));
    const { toCreate, toDelete } = diffTrees(currentTree, newTree);

    await this.applyChangesToContainer(container.id, toCreate, toDelete);
    this.roomFileTrees.set(roomId, newTree);
    return true;
  }

  private async applyChangesToContainer(
    containerId: string,
    toCreate: string[],
    toDelete: string[]
  ): Promise<void> {
    for (const path of toDelete) {
      await this.fileSystemService.execInContainer(
        containerId,
        `rm -rf ${this.fileSystemService.escapePath(path)}`
      );
    }
    for (const path of toCreate) {
      const isFolder = path.endsWith("/");
      await this.fileSystemService.execInContainer(
        containerId,
        isFolder
          ? `mkdir -p ${this.fileSystemService.escapePath(path)}`
          : `touch ${this.fileSystemService.escapePath(path)}`
      );
    }
  }
}

function diffTrees(
  currentTree: FileNode[],
  newTree: FileNode[]
): { toCreate: string[]; toDelete: string[] } {
  const currentPaths = new Set(flattenTree(currentTree));
  const newPaths = new Set(flattenTree(newTree));
  return {
    toCreate: [...newPaths].filter((p) => !currentPaths.has(p)),
    toDelete: [...currentPaths].filter((p) => !newPaths.has(p)),
  };
}

function flattenTree(tree: FileNode[]): string[] {
  return tree.reduce<string[]>((acc, node) => {
    acc.push(node.path);
    if (node.children) acc.push(...flattenTree(node.children));
    return acc;
  }, []);
}
