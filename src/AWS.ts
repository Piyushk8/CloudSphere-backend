
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import Docker from 'dockerode';
import tar from 'tar-stream';
import { Readable } from 'stream';
import dotenv from 'dotenv';
import { readdir } from 'fs/promises';
import path from 'path';

dotenv.config(); // Load variables from .env

// Initialize R2 client using AWS SDK v3
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.CLOUDFLARE_R2_ENDPOINT, // e.g., https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY || '',
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_KEY || '',
  },
});

const docker = new Docker();

// Stream files from R2 directly to a Docker container
export const streamR2FilesToContainer = async (
  r2BucketName: string,
  r2Folder: string,
  containerId: string,
  containerDir: string
) => {
  // Validate parameters
  if (!r2BucketName || !r2Folder || !containerId || !containerDir) {
    throw new Error('R2 bucket name, folder prefix, container ID, and container directory are required');
  }

  // Verify container exists and is running
  const container = docker.getContainer(containerId);
  try {
    const containerInfo = await container.inspect();
    if (!containerInfo.State.Running) {
      throw new Error(`Container with ID ${containerId} is not running`);
    }
  } catch (error: any) {
    console.error(`Error inspecting container ${containerId}:`, error);
    throw new Error(`Failed to verify container: ${error.message}`);
  }

  // Fetch file list from R2
  const listCommand = new ListObjectsV2Command({
    Bucket: r2BucketName,
    Prefix: r2Folder,
  });

  try {
    const { Contents } = await r2Client.send(listCommand);
    if (!Contents || Contents.length === 0) {
      throw new Error(`No files found in R2 bucket ${r2BucketName} under prefix ${r2Folder}`);
    }

    // Process each file
    for (const obj of Contents) {
      if (!obj.Key) continue; 
      if (obj.Key.endsWith('/')) continue; 

      // Construct relative path for the container
      const relativeKey = obj.Key.replace(r2Folder, '').replace(/^\//, ''); // Remove prefix
      const containerFilePath = containerDir.endsWith('/')
        ? `${containerDir}${relativeKey}`
        : `${containerDir}/${relativeKey}`;

      console.log(`Streaming ${obj.Key} to container at ${containerFilePath}`);

      // Fetch file from R2
      const getCommand = new GetObjectCommand({
        Bucket: r2BucketName,
        Key: obj.Key,
      });

      try {
        const { Body } = await r2Client.send(getCommand);
        if (!Body) {
          console.warn(`No content for ${obj.Key}, skipping`);
          continue;
        }

        // Create a tar archive stream
        const pack = tar.pack();
        let fileContent: Buffer;

        if (Body instanceof Readable) {
          // Collect stream into Buffer
          fileContent = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            Body.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            Body.on('end', () => resolve(Buffer.concat(chunks)));
            Body.on('error', reject);
          });
        } else {
          // Handle non-stream body
          fileContent = Buffer.from(await Body.transformToByteArray());
        }

        // Add file to tar archive
        pack.entry({ name: relativeKey }, fileContent);
        pack.finalize();

        // Copy tar stream to container
        await container.putArchive(pack, {
          path: containerDir, // Extract to containerDir; tar preserves relativeKey structure
        });

        console.log(`Copied ${obj.Key} to container at ${containerFilePath}`);
      } catch (error: any) {
        console.error(`Error streaming ${obj.Key} to container:`, error);
        throw new Error(`Failed to stream ${obj.Key}: ${error.message}`);
      }
    }

    console.log(`Completed streaming files to container ${containerId} at ${containerDir}`);
  } catch (error: any) {
    console.error('Error processing R2 files:', error);
    throw new Error(`Failed to stream files to container: ${error.message}`);
  }
};

// Optional: Reuse existing copyFilesToContainer if needed for other local-to-container tasks
export const copyFilesToContainer = async (containerId: string, localDir: string, containerDir: string) => {
  const container = docker.getContainer(containerId);

  try {
    const containerInfo = await container.inspect();
    if (!containerInfo.State.Running) {
      throw new Error(`Container with ID ${containerId} is not running`);
    }

    const files = await readdir(localDir, { recursive: true });
    const validFiles = files.filter((file) =>
      require('fs').statSync(path.join(localDir, file)).isFile()
    );
    if (validFiles.length === 0) {
      throw new Error('No files found to copy from the local directory');
    }

    const pack = tar.pack();
    for (const file of validFiles) {
      const filePath = path.join(localDir, file);
      const relativePath = path.relative(localDir, filePath).replace(/\\/g, '/');
      const fileContent = require('fs').readFileSync(filePath);
      pack.entry({ name: relativePath }, fileContent);
    }
    pack.finalize();

    await container.putArchive(pack, {
      path: containerDir,
    });

    console.log(`Copied ${validFiles.length} files into container at ${containerDir}`);
  } catch (error: any) {
    console.error('Error copying files to container:', error);
    throw new Error(`Failed to copy files to container: ${error.message}`);
  }
};