// // utils/r2Helper.ts
// import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
// import { createReadStream, createWriteStream, promises as fsPromises } from 'fs';
// import { readdir } from 'fs/promises';
// import path from 'path';
// import { DockerManager } from './Docker/DockerManager';
// import dotenv from 'dotenv';
// import { Readable } from 'stream';
// import { mkdirp } from 'mkdirp'; // For creating directories recursively

// dotenv.config(); // Load variables from .env

// // Initialize R2 client using AWS SDK v3
// const r2Client = new S3Client({
//   region: 'auto', // R2 uses 'auto'
//   endpoint: process.env.CLOUDFLARE_R2_ENDPOINT, // e.g., https://<ACCOUNT_ID>.r2.cloudflarestorage.com
//   credentials: {
//     accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY || '',
//     secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_KEY || '',
//   },
// });

// // Download files from Cloudflare R2 bucket
// export const downloadFilesFromR2 = async (r2BucketName: string, r2Folder: string, localDir: string) => {
//   // Validate parameters
//   if (!r2BucketName || !r2Folder || !localDir) {
//     throw new Error('R2 bucket name, folder prefix, and local directory are required');
//   }

//   // Ensure local directory exists
//   await mkdirp(localDir);

//   // Fetch file list from R2
//   const listCommand = new ListObjectsV2Command({
//     Bucket: r2BucketName,
//     Prefix: r2Folder,
//   });

//   try {
//     const { Contents } = await r2Client.send(listCommand);
//     if (!Contents || Contents.length === 0) {
//       throw new Error(`No files found in R2 bucket ${r2BucketName} under prefix ${r2Folder}`);
//     }

//     // Download each file
//     for (const obj of Contents) {
//       if (!obj.Key) continue; // Skip invalid keys
//       if (obj.Key.endsWith('/')) continue; // Skip folder entries

//       // Construct local file path
//       const relativeKey = obj.Key.replace(r2Folder, '').replace(/^\//, ''); // Remove prefix
//       const filePath = path.join(localDir, relativeKey);
//       const fileDir = path.dirname(filePath);

//       // Ensure the file's directory exists
//       await mkdirp(fileDir);

//       // Download file
//       const getCommand = new GetObjectCommand({
//         Bucket: r2BucketName,
//         Key: obj.Key,
//       });

//       try {
//         const { Body } = await r2Client.send(getCommand);
//         if (!Body) {
//           console.warn(`No content for ${obj.Key}, skipping`);
//           continue;
//         }

//         // Write file to disk
//         const fileStream = createWriteStream(filePath);
//         if (Body instanceof Readable) {
//           Body.pipe(fileStream);
//         } else {
//           // Handle non-stream body (e.g., Buffer)
//           fileStream.write(await Body.transformToByteArray());
//           fileStream.end();
//         }

//         // Wait for the file download to complete
//         await new Promise<void>((resolve, reject) => {
//           fileStream.on('finish', resolve);
//           fileStream.on('error', reject);
//         });

//         console.log(`Downloaded ${obj.Key} to ${filePath}`);
//       } catch (error) {
//         console.error(`Error downloading ${obj.Key}:`, error);
//         throw error; // Rethrow to fail fast; adjust based on your needs
//       }
//     }
//   } catch (error: any) {
//     console.error('Error downloading files from R2:', error);
//     throw new Error(`Failed to download files: ${error.message}`);
//   }
// };

// // Copy files from a local directory to the container
// export const copyFilesToContainer = async (containerId: string, localDir: string, containerDir: string) => {
//   const dockerManager = new DockerManager();
//   const container = dockerManager.docker.getContainer(containerId);

//   try {
//     // Ensure the container exists
//     const containerInfo = await container.inspect();
//     if (!containerInfo.State.Running) {
//       throw new Error(`Container with ID ${containerId} is not running`);
//     }

//     const files = await readdir(localDir, { recursive: true });
//     const validFiles = files.filter((file) => !fsPromises.stat(path.join(localDir, file)).then((s) => s.isDirectory()));
//     if (validFiles.length === 0) {
//       throw new Error('No files found to copy from the local directory');
//     }

//     for (const file of validFiles) {
//       const filePath = path.join(localDir, file);
//       const containerFilePath = path.posix.join(containerDir, file.replace(/\\/g, '/')); // Ensure POSIX paths for container

//       console.log(`Copying ${filePath} to container at ${containerFilePath}...`);

//       // Create a tar archive for the file (Docker requires tar for putArchive)
//       const tarStream = createReadStream(filePath); // Simplified; use `tar` library for complex cases
//       await container.putArchive(tarStream, {
//         path: path.posix.dirname(containerFilePath),
//       });
//     }

//     console.log(`Copied ${validFiles.length} files into container at ${containerDir}`);
//   } catch (error: any) {
//     console.error('Error copying files to container:', error);
//     throw new Error(`Failed to copy files to container: ${error.message}`);
//   }
// };




// utils/r2Helper.ts
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

// Initialize Dockerode client
const docker = new Docker(); // Adjust if you need specific Docker host/port options

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
      if (!obj.Key) continue; // Skip invalid keys
      if (obj.Key.endsWith('/')) continue; // Skip folder entries

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