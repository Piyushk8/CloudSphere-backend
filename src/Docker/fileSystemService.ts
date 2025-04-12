import Docker from "dockerode";

export type FileType = "file" | "folder" | "symlink" | "executable";

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type: FileType;
  children?: FileNode[];
}

export class FileSystemService {
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  /**
   * Executes a command in a Docker container, handling multiplexed streams properly.
   */
  async execInContainer(containerId: string, command: string): Promise<string> {
    const container = this.docker.getContainer(containerId);
    try {
      await container.inspect(); // Verify container exists

      const exec = await container.exec({
        Cmd: ["sh", "-c", command],
        AttachStdout: true,
        AttachStderr: true,
        Tty:false
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      let stdout = "";
      let stderr = "";

      return new Promise((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => {
          let offset = 0;
          while (offset < chunk.length) {
            const header = chunk.slice(offset, offset + 8);
            const streamType = header[0]; // 1 = stdout, 2 = stderr
            const size = header.readUInt32BE(4);
            const payload = chunk
              .slice(offset + 8, offset + 8 + size)
              .toString("utf8");
            if (streamType === 1) stdout += payload;
            else if (streamType === 2) stderr += payload;
            offset += 8 + size;
          }
        });

        stream.on("end", () => {
          if (stderr) console.error(`Stderr for '${containerId}': ${stderr}`);
          resolve(stdout.trim());
        });

        stream.on("error", (err) => reject(new Error(`Stream error: ${err.message}`)));
      });
    } catch (error) {
      console.error(`Exec failed in container '${containerId}':`, error);
      throw new Error(`Failed to execute command: ${(error as Error).message}`);
    }
  }

  /**
   * Retrieves the file tree for a container, ensuring accurate type detection.
   */
  async getFileTree(containerId: string): Promise<FileNode[]> {
    const output = await this.execInContainer(
      containerId,
      "find /workspace -not -path '*/\\.*' -printf '%y|%p\\n'" // Exclude hidden files
    );
    if (!output) return [];

    const paths = output
      .split("\n")
      .map((line): { path: string; type: FileType } | null => {
        const [typeChar, path] = line.trim().split("|", 2);
        if (!typeChar || !path || /[\u0000-\u001F]/.test(path)) return null;

        let type: FileType;
        switch (typeChar) {
          case "d":
            type = "folder";
            break;
          case "l":
            type = "symlink";
            break;
          case "f":
            type = "file"; // Executables checked separately
            break;
          default:
            return null; // Skip unknown types
        }
        return { path, type };
      })
      .filter((entry): entry is { path: string; type: FileType } => entry !== null);

    const executablePaths = await this.getExecutablePaths(containerId);
    paths.forEach((entry) => {
      if (entry.type === "file" && executablePaths.has(entry.path)) {
        entry.type = "executable";
      }
    });

    return this.buildTree(paths);
  }

  /**
   * Retrieves paths of executable files in the container.
   */
  private async getExecutablePaths(containerId: string): Promise<Set<string>> {
    try {
      const output = await this.execInContainer(
        containerId,
        "find /workspace -type f -executable -printf '%p\\n'"
      );
      return new Set(output.split("\n").map((p) => p.trim()).filter(Boolean));
    } catch (error) {
      console.error(`Failed to get executable paths: ${error}`);
      return new Set();
    }
  }

  /**
   * Builds a hierarchical file tree, preventing duplicates and corruption.
   */
  private buildTree(paths: { path: string; type: FileType }[]): FileNode[] {
    const tree: Record<string, FileNode> = {};
    let idCounter = 1;

    paths.forEach(({ path, type }) => {
      const parts = path.split("/").filter(Boolean);
      let parentKey: string | null = null;

      for (let index = 0; index < parts.length; index++) {
        const isLeaf = index === parts.length - 1;
        const key = "/" + parts.slice(0, index + 1).join("/");

        if (!tree[key]) {
          tree[key] = {
            id: String(idCounter++),
            name: parts[index],
            path: key,
            type: isLeaf ? type : "folder",
            children: isLeaf ? undefined : [],
          };
        } else if (!isLeaf && tree[key].type !== "folder") {
          tree[key].type = "folder";
          tree[key].children = tree[key].children || [];
        }

        if (parentKey && tree[parentKey]) {
          tree[parentKey].children = tree[parentKey].children || [];
          if (!tree[parentKey].children!.some((child) => child.path === key)) {
            tree[parentKey].children!.push(tree[key]);
          }
        }

        parentKey = key;
      }
    });

    const root = tree["/workspace"];
    return root ? [root] : [];
  }

  public async getFullFileTree(containerId: string): Promise<FileNode[]> {
    return this.getFileTree(containerId);
  }
}