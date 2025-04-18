import Docker from 'dockerode';

export type FileType = 'file' | 'folder' | 'symlink' | 'executable';

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
   * Executes a command in a Docker container, handling multiplexed streams.
   */
  async execInContainer(containerId: string, command: string): Promise<string> {
    const container = this.docker.getContainer(containerId);
    try {
      await container.inspect(); // Verify container exists

      const exec = await container.exec({
        Cmd: ['sh', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      let stdout = '';
      let stderr = '';

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          let offset = 0;
          while (offset < chunk.length) {
            const header = chunk.slice(offset, offset + 8);
            const streamType = header[0]; // 1 = stdout, 2 = stderr
            const size = header.readUInt32BE(4);
            const payload = chunk
              .slice(offset + 8, offset + 8 + size)
              .toString('utf8');
            if (streamType === 1) stdout += payload;
            else if (streamType === 2) stderr += payload;
            offset += 8 + size;
          }
        });

        stream.on('end', () => {
          if (stderr) console.error(`Stderr for '${containerId}': ${stderr}`);
          resolve(stdout.trim());
        });

        stream.on('error', (err) => reject(new Error(`Stream error: ${err.message}`)));
      });
    } catch (error: any) {
      console.error(`Exec failed in container '${containerId}':`, error);
      throw new Error(`Failed to execute command: ${error.message}`);
    }
  }

  /**
   * Retrieves the file tree for a container, capturing all files and folders.
   */
  async getFileTree(containerId: string): Promise<FileNode[]> {
    // Use a minimal find command to list all entries
    const output = await this.execInContainer(
      containerId,
      `find /workspace -printf '%y|%p|%m\\n' 2>/tmp/find_errors.log || cat /tmp/find_errors.log`
      // Capture type, path, mode; log errors to a file
    );

    console.log(`Raw find output:\n${output}`);

    if (!output) {
      console.warn(`No output from find in container ${containerId}`);
      return [];
    }

    const paths = output
      .split('\n')
      .map((line, index): { path: string; type: FileType; mode: number } | null => {
        if (!line.trim()) {
          console.warn(`Skipping empty line at index ${index}`);
          return null;
        }

        const [typeChar, path, mode] = line.split('|', 3);
        if (!typeChar || !path || !mode) {
          console.warn(`Skipping invalid line at index ${index}: ${line}`);
          return null;
        }

        let type: FileType;
        switch (typeChar) {
          case 'd':
            type = 'folder';
            break;
          case 'f':
            type = 'file';
            break;
          case 'l':
            type = 'symlink';
            break;
          default:
            console.warn(`Unknown type '${typeChar}' for path: ${path}`);
            return null;
        }

        return { path, type, mode: parseInt(mode, 8) };
      })
      .filter((entry): entry is { path: string; type: FileType; mode: number } => entry !== null);

    // Mark executables
    paths.forEach((entry) => {
      if (entry.type === 'file' && (entry.mode & 0o111) !== 0) {
        entry.type = 'executable';
      }
    });

    console.log(`Parsed ${paths.length} paths:`, paths.map((p) => p.path));

    return this.buildTree(paths);
  }

  /**
   * Builds a hierarchical file tree, ensuring all paths are included.
   */
  private buildTree(paths: { path: string; type: FileType }[]): FileNode[] {
    const tree: Record<string, FileNode> = {};
    let idCounter = 1;

    // Seed root node
    tree['/workspace'] = {
      id: String(idCounter++),
      name: 'workspace',
      path: '/workspace',
      type: 'folder',
      children: [],
    };

    paths.forEach(({ path, type }, index) => {
      if (path === '/workspace' && type === 'folder') {
        console.log(`Skipping root path at index ${index}: ${path}`);
        return;
      }

      const parts = path.split('/').filter(Boolean);
      if (parts[0] !== 'workspace') {
        console.warn(`Skipping invalid path (not under /workspace) at index ${index}: ${path}`);
        return;
      }

      let parentKey = '';
      for (let i = 0; i < parts.length; i++) {
        const isLeaf = i === parts.length - 1;
        const key = '/' + parts.slice(0, i + 1).join('/');

        if (!tree[key]) {
          tree[key] = {
            id: String(idCounter++),
            name: parts[i],
            path: key,
            type: isLeaf ? type : 'folder',
            children: isLeaf ? undefined : [],
          };
          console.log(`Created node: ${key} (${tree[key].type})`);
        } else if (!isLeaf && tree[key].type !== 'folder') {
          console.log(`Converting ${key} to folder`);
          tree[key].type = 'folder';
          tree[key].children = tree[key].children || [];
        }

        if (parentKey && tree[parentKey]) {
          tree[parentKey].children = tree[parentKey].children || [];
          if (!tree[parentKey].children!.some((child) => child.path === key)) {
            tree[parentKey].children!.push(tree[key]);
            console.log(`Added ${key} as child of ${parentKey}`);
          }
        }

        parentKey = key;
      }
    });

    // Sort children for consistency
    Object.values(tree).forEach((node) => {
      if (node.children) {
        node.children.sort((a, b) => a.name.localeCompare(b.name));
      }
    });

    const root = tree['/workspace'];
    if (!root.children?.length) {
      console.warn('Root node has no children; tree may be incomplete');
    }

    return root ? [root] : [];
  }

  public async getFullFileTree(containerId: string): Promise<FileNode[]> {
    return this.getFileTree(containerId);
  }
}