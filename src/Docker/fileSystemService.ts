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

  /** Escapes a path to prevent command injection. */
  public escapePath(path: string): string {
    return "'" + path.replace(/'/g, "'\\''") + "'";
  }

  /**
   * Executes a command in a Docker container, returning output and exit code.
   */
  async execInContainer(containerId: string, command: string): Promise<{ output: string; exitCode: number }> {
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

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          let offset = 0;
          while (offset < chunk.length) {
            const header = chunk.slice(offset, offset + 8);
            const streamType = header[0];
            const size = header.readUInt32BE(4);
            const payload = chunk.slice(offset + 8, offset + 8 + size).toString('utf8');
            if (streamType === 1) stdout += payload;
            else if (streamType === 2) stderr += payload;
            offset += 8 + size;
          }
        });

        stream.on('end', resolve);
        stream.on('error', reject);
      });

      const inspect = await exec.inspect();
      const exitCode = inspect.ExitCode ?? -1;

      if (stderr) console.error(`Stderr for '${containerId}': ${stderr}`);
      return { output: stdout.trim(), exitCode };
    } catch (error: any) {
      console.error(`Exec failed in container '${containerId}':`, error);
      throw new Error(`Failed to execute command: ${error.message}`);
    }
  }

  /**
   * Retrieves the file tree for the /workspace directory in a container.
   */
  async getFileTree(containerId: string): Promise<FileNode[]> {
    const { output } = await this.execInContainer(
      containerId,
      `find /workspace -printf '%y|%p|%m\\n' 2>/tmp/find_errors.log || cat /tmp/find_errors.log`
    );

    if (!output) {
      console.warn(`No output from find in container ${containerId}`);
      return [];
    }

    const paths = output
      .split('\n')
      .map((line): { path: string; type: FileType; mode: number } | null => {
        if (!line.trim()) return null;
        const [typeChar, path, mode] = line.split('|', 3);
        if (!typeChar || !path || !mode) return null;
        let type: FileType;
        switch (typeChar) {
          case 'd': type = 'folder'; break;
          case 'f': type = 'file'; break;
          case 'l': type = 'symlink'; break;
          default: return null;
        }
        return { path, type, mode: parseInt(mode, 8) };
      })
      .filter((entry): entry is { path: string; type: FileType; mode: number } => entry !== null);

    paths.forEach((entry) => {
      if (entry.type === 'file' && (entry.mode & 0o111) !== 0) {
        entry.type = 'executable';
      }
    });

    return this.buildTree(paths);
  }

  /** Builds a hierarchical file tree from a flat list of paths. */
  private buildTree(paths: { path: string; type: FileType }[]): FileNode[] {
    const tree: Record<string, FileNode> = {};
    let idCounter = 1;

    tree['/workspace'] = {
      id: String(idCounter++),
      name: 'workspace',
      path: '/workspace',
      type: 'folder',
      children: [],
    };

    paths.forEach(({ path, type }) => {
      if (path === '/workspace' && type === 'folder') return;
      const parts = path.split('/').filter(Boolean);
      if (parts[0] !== 'workspace') return;
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
        } else if (!isLeaf && tree[key].type !== 'folder') {
          tree[key].type = 'folder';
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

    Object.values(tree).forEach((node) => {
      if (node.children) {
        node.children.sort((a, b) => a.name.localeCompare(b.name));
      }
    });

    return tree['/workspace'] ? [tree['/workspace']] : [];
  }

  public async getFullFileTree(containerId: string): Promise<FileNode[]> {
    return this.getFileTree(containerId);
  }
}