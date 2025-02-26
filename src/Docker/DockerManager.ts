import Docker from "dockerode";
import path from "path";
import fs from "fs/promises";

export interface ContainerOptions {
  image: string; // Docker image (e.g., "node:18", "python:3.10", "openjdk:17")
  roomId: string; // Unique ID for workspace/container
  exposedPort?: number; // Optional: Default internal port (e.g., 8080 for Node, 5000 for Flask)
  envVars?: string[]; // Optional: Environment variables (e.g., ["NODE_ENV=production"])
}

export class DockerManager {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  async createContainer(options: ContainerOptions): Promise<{ containerId: string; hostPort: number }> {
    try {
      const { image, roomId, exposedPort = 8080, envVars = [] } = options;
      const hostPort = await this.getAvailablePort(4000, 5000); // Ensure an available port
      const workspacePath = path.resolve("storage", roomId);

      // Ensure the workspace directory exists before creating the container
      await fs.mkdir(workspacePath, { recursive: true });

      // Check if the image exists locally; if not, pull it
      const images = await this.docker.listImages();
      const imageExists = images.some((img) => img.RepoTags?.includes(image));

      if (!imageExists) {
        console.log(`❌ Image '${image}' not found locally. Pulling from Docker Hub...`);
        await new Promise<void>((resolve, reject) => {
          this.docker.pull(image, (err: Error, stream: NodeJS.ReadableStream) => {
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
      const container = await this.docker.createContainer({
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

      await container.start();
      console.log(`✅ Container started for '${roomId}' using '${image}' on port ${hostPort}`);

      return { containerId: container.id, hostPort };
    } catch (error: any) {
      console.error("❌ Error creating container:", error.message || error);
      throw error;
    }
  }

  async getContainer(roomId: string) {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const found = containers.filter((c) => c.Names.includes(`/room-${roomId}`));
      if (!found) {
        console.error(`🚨 Container not found for roomId: ${roomId}`);
        return null;
      }
      return this.docker.getContainer(found[0].Id);
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
async listFiles(roomId: string): Promise<string[]> {
  const output = await this.execInContainer(roomId, "ls /workspace");
  return output ? output.split("\n") : [];
}
async readFile(roomId: string, filename: string): Promise<string> {
  return this.execInContainer(roomId, `cat /workspace/${filename}`);
}
async writeFile(roomId: string, filename: string, content: string): Promise<void> {
  await this.execInContainer(roomId, `echo ${JSON.stringify(content)} > /workspace/${filename}`);
}
async deleteFile(roomId: string, filename: string): Promise<void> {
  await this.execInContainer(roomId, `rm /workspace/${filename}`);
}


}


