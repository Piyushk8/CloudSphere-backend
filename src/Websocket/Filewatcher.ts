//! previous implementation 
/** 
 * This was used when working with the mount binds as they were stored on host machine as I migrated to in container 
 * 
 * **/


// import chokidar from "chokidar";
// import fs from "fs/promises";
// import path from "path";
// import { webSocketServiceInstance } from "..";
// import { DockerManager } from "../Docker/DockerManager";
// import { FileNode } from "../Docker/fileSystemService";

// const watchers = new Map<string, chokidar.FSWatcher>();

// // Deep comparison of file trees
// function areTreesEqual(tree1: FileNode[], tree2: FileNode[]): boolean {
//   const flatten = (tree: FileNode[]): string =>
//     JSON.stringify(
//       tree.map((node) => ({
//         id: node.id,
//         name: node.name,
//         path: node.path,
//         type: node.type,
//         children: node.children ? flatten(node.children) : undefined,
//       })),
//       null,
//       0
//     );
//   return flatten(tree1) === flatten(tree2);
// }

// // Debounce utility
// function debounce<T extends (...args: any[]) => void>(func: T, wait: number) {
//   let timeout: NodeJS.Timeout;
//   return (...args: Parameters<T>) => {
//     clearTimeout(timeout);
//     timeout = setTimeout(() => func(...args), wait);
//   };
// }

// export async function watchRoomFiles(roomId: string): Promise<void> {
//   const dockerManager = new DockerManager();

  
//   try {
//     const container = await dockerManager.getContainer(roomId);
//     if (!container) {
//       console.error(`🚨 No container found for roomId: ${roomId}`);
//       return;
//     }

//     const containerInfo = await container.inspect();
//     const workspacePath = containerInfo.Mounts.find((m) => m.Destination === "/workspace")?.Source;
//     if (!workspacePath) {
//       console.error(`🚨 No workspace mount found for roomId: ${roomId}`);
//       return;
//     }

//     try {
//       await fs.access(workspacePath);
//     } catch (error) {
//       console.error(`🚨 Workspace path '${workspacePath}' inaccessible:`, error);
//       return;
//     }

//     if (watchers.has(roomId)) {
//       console.warn(`⚠️ Already watching room: ${roomId}`);
//       return;
//     }

//     const watcher = chokidar.watch(workspacePath, {
//       persistent: true,
//       ignoreInitial: true,
//       depth: 99,
//       awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
//       usePolling: true,
//       interval: 500,
//       binaryInterval: 1000,
//       ignored: ["**/node_modules/**"],
//     });

//     watchers.set(roomId, watcher);

//     let lastTree: FileNode[] = await dockerManager.getFileTree(roomId);

//     const emitUpdate = debounce(async () => {
//       try {
//         const newTree = await dockerManager.getFileTree(roomId);
//         if (!areTreesEqual(lastTree, newTree)) {
//           console.log(`📂 [${roomId}] Tree updated, emitting changes`);
//           webSocketServiceInstance.emitToRoom(roomId, "directory:changed", newTree);
//           lastTree = newTree;
//         }
//       } catch (error) {
//         console.error(`❌ Failed to fetch updated tree for '${roomId}':`, error);
//       }
//     }, 1000);

//     watcher.on("ready", () => {
//       console.log(`✅ Watcher ready for room '${roomId}' at '${workspacePath}'`);
//     });

//     watcher.on("all", (event, filePath) => {
//       console.log(`📂 [${roomId}] Event: ${event} on ${filePath}`);
//       emitUpdate();
//     });

//     watcher.on("error", (error) => {
//       console.error(`❌ Watcher error for room '${roomId}':`, error);
//     });
//   } catch (error) {
//     console.error(`❌ Error setting up watcher for roomId '${roomId}':`, error);
//   }
// }

// export async function stopWatchingRoomFiles(roomId: string): Promise<void> {
//   const watcher = watchers.get(roomId);
//   if (watcher) {
//     await watcher.close();
//     watchers.delete(roomId);
//     console.log(`🛑 Stopped watching room '${roomId}'`);
//   }
// }

// export async function cleanupAllWatchers(): Promise<void> {
//   for (const [roomId, watcher] of watchers) {
//     await watcher.close();
//     console.log(`🛑 Cleaned up watcher for room '${roomId}'`);
//   }
//   watchers.clear();
// }

// process.on("SIGINT", async () => {
//   await cleanupAllWatchers();
//   process.exit(0);
// });