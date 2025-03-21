import chokidar from "chokidar";
import fs from "fs";
import path from "path";
import { webSocketServiceInstance } from "..";
import { DockerManager } from "../Docker/DockerManager";

const watchers = new Map(); // Stores watchers per room

export async function watchRoomFiles(roomId: string) {
    const dockerManager = new DockerManager();
    try {
        const container = await dockerManager.getContainer(roomId);
        if (!container) {
            console.error(`🚨 No container found for roomId: ${roomId}`);
            return;
        }

        // Get container details to find the mounted path
        const containerInfo = await container.inspect();
        const workspacePath = containerInfo.Mounts.find(m => m.Destination === "/workspace")?.Source;

        if (!workspacePath) {
            console.error(`🚨 Could not determine workspace path for roomId: ${roomId}`);
            return;
        }

        // console.log(`✅ Watching files at: ${workspacePath}`);

        // Avoid duplicate watchers
        if (watchers.has(roomId)) {
            console.warn(`⚠️ Already watching room: ${roomId}`);
            return;
        }

        const watcher = chokidar.watch(workspacePath, {
            persistent: true,
            ignoreInitial: false,
            depth: 99,
        });

        watchers.set(roomId, watcher);

        watcher.on('all', async (event, filePath) => {
            // console.log(`📂 [${roomId}] Event: ${event} on ${filePath}`);

            // const updatedFileTree = await dockerManager.getFileTree(roomId);
            // webSocketServiceInstance.emitToRoom(roomId,"directory:changed", updatedFileTree);
        });

    } catch (error) {
        console.error(`❌ Error watching files for roomId ${roomId}:`, error);
    }
}
