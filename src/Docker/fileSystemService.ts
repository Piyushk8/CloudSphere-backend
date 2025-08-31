import Docker from 'dockerode';

export type FileType = 'file' | 'folder' | 'symlink' | 'executable';

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type: FileType;
  children?: FileNode[];
  size?: number;
  lastModified?: Date;
}

export class FileSystemService {
  private docker: Docker;
  // Production-ready blacklist for common unwanted directories
  private readonly BLACKLISTED_DIRS = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    'coverage',
    '.nyc_output',
    'logs',
    '*.log',
    '.DS_Store',
    'Thumbs.db',
    '.vscode',
    '.idea',
    '.pytest_cache',
    '__pycache__',
    '.cache',
    'tmp',
    'temp',
    '.tmp',
    '.temp',
    'vendor',
    '.vendor',
    '.next',
    '.nuxt',
    'out',
    '.out',
    'target',
    '.gradle',
    '.mvn',
    'bin',
    'obj',
    '.sass-cache',
    '.parcel-cache',
    '.turbo'
  ]);

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

  // File extensions to treat as executable
  private readonly EXECUTABLE_EXTENSIONS = new Set([
    '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
    '.exe', '.app', '.deb', '.rpm', '.dmg', '.pkg'
  ]);

  async getFileTree(containerId: string, maxDepth: number = 10): Promise<FileNode[]> {
    try {
      // Use a more robust find command with better error handling
      const blacklistPattern = Array.from(this.BLACKLISTED_DIRS)
        .map(dir => `-name "${dir}"`)
        .join(' -o ');

      const findCommand = `
        find /workspace -maxdepth ${maxDepth} \\
          \\( ${blacklistPattern} \\) -prune -o \\
          -type f -printf 'f|%p|%s|%T@\\n' -o \\
          -type d -printf 'd|%p|0|%T@\\n' -o \\
          -type l -printf 'l|%p|0|%T@\\n' \\
        2>/dev/null | grep -v '^[fdl]|/workspace$' | head -10000
      `;

      const { output } = await this.execInContainer(containerId, findCommand);

      if (!output?.trim()) {
        console.warn(`No output from find in container ${containerId}`);
        return this.createEmptyWorkspaceTree();
      }

      return this.parseAndBuildTree(output);
    } catch (error) {
      console.error(`Error getting file tree for container ${containerId}:`, error);
      return this.createEmptyWorkspaceTree();
    }
  }

  private parseAndBuildTree(output: string): FileNode[] {
    const entries: Array<{
      path: string;
      type: FileType;
      size: number;
      lastModified: Date;
    }> = [];

    const lines = output.trim().split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length !== 4) continue;

      const [typeChar, fullPath, sizeStr, timestampStr] = parts;
      
      // Skip invalid paths or paths outside workspace
      if (!fullPath.startsWith('/workspace/') || fullPath === '/workspace') {
        continue;
      }

      // Skip blacklisted items (additional check)
      const pathParts = fullPath.split('/');
      if (pathParts.some(part => this.BLACKLISTED_DIRS.has(part))) {
        continue;
      }

      let type: FileType;
      switch (typeChar) {
        case 'd':
          type = 'folder';
          break;
        case 'f':
          type = this.isExecutableFile(fullPath) ? 'executable' : 'file';
          break;
        case 'l':
          type = 'symlink';
          break;
        default:
          continue;
      }

      const size = parseInt(sizeStr, 10) || 0;
      const lastModified = new Date(parseFloat(timestampStr) * 1000);

      entries.push({
        path: fullPath,
        type,
        size,
        lastModified
      });
    }

    return this.buildHierarchicalTree(entries);
  }

  private buildHierarchicalTree(entries: Array<{
    path: string;
    type: FileType;
    size: number;
    lastModified: Date;
  }>): FileNode[] {
    const nodeMap = new Map<string, FileNode>();
    let idCounter = 1;

    // Create root workspace node
    const rootNode: FileNode = {
      id: String(idCounter++),
      name: 'workspace',
      path: '/workspace',
      type: 'folder',
      children: []
    };
    nodeMap.set('/workspace', rootNode);

    // Sort entries by path depth to ensure parents are created before children
    entries.sort((a, b) => {
      const depthA = a.path.split('/').length;
      const depthB = b.path.split('/').length;
      return depthA - depthB;
    });

    for (const entry of entries) {
      const { path, type, size, lastModified } = entry;
      
      // Skip if already exists
      if (nodeMap.has(path)) continue;

      // Get the file/folder name (last part of path)
      const pathParts = path.split('/').filter(Boolean);
      const name = pathParts[pathParts.length - 1];
      
      // Create the node
      const node: FileNode = {
        id: String(idCounter++),
        name,
        path,
        type,
        ...(type !== 'folder' && { size }),
        lastModified,
        ...(type === 'folder' && { children: [] })
      };

      nodeMap.set(path, node);

      // Find and create parent directories if they don't exist
      let parentPath = '/workspace';
      for (let i = 2; i < pathParts.length; i++) { // Start from 2 to skip 'workspace'
        const currentPath = '/' + pathParts.slice(0, i).join('/');
        
        if (!nodeMap.has(currentPath)) {
          const parentName = pathParts[i - 1];
          const parentNode: FileNode = {
            id: String(idCounter++),
            name: parentName,
            path: currentPath,
            type: 'folder',
            children: []
          };
          nodeMap.set(currentPath, parentNode);

          // Add to its parent
          const grandParent = nodeMap.get(parentPath);
          if (grandParent?.children) {
            grandParent.children.push(parentNode);
          }
        }
        parentPath = currentPath;
      }

      // Add current node to its parent
      const parent = nodeMap.get(parentPath);
      if (parent?.children && !parent.children.some(child => child.path === path)) {
        parent.children.push(node);
      }
    }

    // Sort all children alphabetically (folders first, then files)
    this.sortTreeNodes(rootNode);

    return [rootNode];
  }

  private sortTreeNodes(node: FileNode): void {
    if (!node.children) return;

    // Sort children: folders first, then by name
    node.children.sort((a, b) => {
      // Folders come first
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      
      // Then sort alphabetically (case-insensitive)
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    // Recursively sort children
    for (const child of node.children) {
      this.sortTreeNodes(child);
    }
  }

  private isExecutableFile(filePath: string): boolean {
    const ext = this.getFileExtension(filePath);
    return this.EXECUTABLE_EXTENSIONS.has(ext);
  }

  private getFileExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    return lastDot > 0 ? filePath.substring(lastDot).toLowerCase() : '';
  }

  private createEmptyWorkspaceTree(): FileNode[] {
    return [{
      id: '1',
      name: 'workspace',
      path: '/workspace',
      type: 'folder',
      children: []
    }];
  }

  // Public method for getting full tree (same as getFileTree but with explicit naming)
  public async getFullFileTree(containerId: string, maxDepth?: number): Promise<FileNode[]> {
    return this.getFileTree(containerId, maxDepth);
  }

  // Helper method to get tree with custom blacklist
  public async getFileTreeWithCustomBlacklist(
    containerId: string, 
    additionalBlacklist: string[] = [],
    maxDepth: number = 10
  ): Promise<FileNode[]> {
    const originalBlacklist = new Set(this.BLACKLISTED_DIRS);
    
    // Temporarily add custom blacklist items
    additionalBlacklist.forEach(item => this.BLACKLISTED_DIRS.add(item));
    
    try {
      return await this.getFileTree(containerId, maxDepth);
    } finally {
      // Restore original blacklist
      this.BLACKLISTED_DIRS.clear();
      originalBlacklist.forEach(item => this.BLACKLISTED_DIRS.add(item));
    }
  }

  // Helper method to check if a path should be blacklisted
  public isBlacklisted(path: string): boolean {
    const pathParts = path.split('/');
    return pathParts.some(part => this.BLACKLISTED_DIRS.has(part));
  }

  // Method to get file tree statistics
  public async getFileTreeStats(containerId: string): Promise<{
    totalFiles: number;
    totalFolders: number;
    totalSize: number;
    largestFile: { name: string; size: number } | null;
  }> {
    const tree = await this.getFileTree(containerId);
    const stats = {
      totalFiles: 0,
      totalFolders: 0,
      totalSize: 0,
      largestFile: null as { name: string; size: number } | null
    };

    const traverse = (node: FileNode) => {
      if (node.type === 'folder') {
        stats.totalFolders++;
        node.children?.forEach(traverse);
      } else {
        stats.totalFiles++;
        if (node.size) {
          stats.totalSize += node.size;
          if (!stats.largestFile || node.size > stats.largestFile.size) {
            stats.largestFile = { name: node.name, size: node.size };
          }
        }
      }
    };

    tree.forEach(traverse);
    return stats;
  }
}