import { ExecInspectInfo } from "dockerode";
import { webSocketServiceInstance } from "..";
import { DockerManager } from "../Docker/DockerManager";
import { FileNode } from "../Docker/fileSystemService";
import { Writable } from "stream";

// Debounce utility
function debounce<T extends (...args: any[]) => void>(func: T, wait: number) {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

// Track active inotify processes
import { Readable } from "stream";

const watchers = new Map<
  string,
  {
    containerId: string;
    process: any;
    stream: Readable; // Explicitly tell TS it's Node.js stream
  }
>();



export async function watchRoomFiles(roomId: string): Promise<void> {
  const dockerManager = new DockerManager();

  try {
    const container = await dockerManager.getContainer(roomId);
    if (!container?.id) {
      console.error(`🚨 No container found for roomId: ${roomId}`);
      return;
    }

    if (watchers.has(roomId)) {
      console.warn(`⚠️ Already watching room: ${roomId}`);
      return;
    }

    // Ensure inotify-tools is installed
    try {
      await dockerManager.fileSystemService.execInContainer(
        container.id,
        "apt-get update && apt-get install -y inotify-tools || true"
      );
      console.log(`✅ Installed inotify-tools in container ${container.id}`);
    } catch (error) {
      console.error(
        `❌ Failed to install inotify-tools in ${container.id}:`,
        error
      );
      return;
    }

    // Start inotifywait process
    const exec = await dockerManager.docker.getContainer(container.id).exec({
      Cmd: [
        "sh",
        "-c",
        "inotifywait -m /workspace -r -e create -e modify -e delete --exclude '/node_modules/'",
      ],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    watchers.set(roomId, { containerId: container.id, process: { exec, stream }, stream })

    let lastTree: FileNode[] = await dockerManager.getFileTree(roomId);

    const emitUpdate = debounce(async () => {
      try {
        const newTree = await dockerManager.getFileTree(roomId);
        console.log(`📂 [${roomId}] Tree updated, emitting changes`);
        webSocketServiceInstance.emitToRoom(
          roomId,
          "directory:changed",
          newTree
        );
        lastTree = newTree;
      } catch (error) {
        console.error(
          `❌ Failed to fetch updated tree for '${roomId}':`,
          error
        );
      }
    }, 1000);

    const stdoutStream = new Writable({
      write(chunk, _encoding, callback) {
        const event = chunk.toString("utf8").trim();
        if (event) {
          console.log(`📂 [${roomId}] Inotify event: ${event}`);
          emitUpdate();
        }
        callback(); // must call this!
      },
    });

    const stderrStream = new Writable({
      write(chunk, _encoding, callback) {
        console.error(
          `❌ Inotify stderr for ${roomId}: ${chunk.toString("utf8")}`
        );
        callback(); // must call this!
      },
    });

    dockerManager.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    stream.on("end", () => {
      console.log(`🛑 Inotify stream ended for room ${roomId}`);
      watchers.delete(roomId);
    });

    stream.on("error", (error) => {
      console.error(`❌ Inotify stream error for room ${roomId}:`, error);
      watchers.delete(roomId);
    });

    console.log(
      `✅ Watcher started for room '${roomId}' in container ${container.id}`
    );
  } catch (error) {
    console.error(`❌ Error setting up watcher for roomId '${roomId}':`, error);
  }
}

export async function stopWatchingRoomFiles(roomId: string): Promise<void> {
  const watcher = watchers.get(roomId);
  if (watcher) {
    try {
      watcher.stream.destroy();
      // Attempt to kill the exec process
      await watcher.process.exec.inspect().then((info:ExecInspectInfo) => {
        if (info.Running) {
          console.log(`🛑 Closed stream for room '${roomId}'`);
        }
      });
    } catch (error) {
      console.error(`❌ Error stopping watcher for '${roomId}':`, error);
    }
    watchers.delete(roomId);
    console.log(`🛑 Stopped watching room '${roomId}'`);
  }
}

export async function cleanupAllWatchers(): Promise<void> {
  for (const [roomId] of watchers) {
    await stopWatchingRoomFiles(roomId);
  }
  console.log(`🛑 Cleaned up all watchers`);
}

process.on("SIGINT", async () => {
  await cleanupAllWatchers();
  process.exit(0);
});
