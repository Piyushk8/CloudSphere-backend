import { Server as SocketServer, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { DockerManager } from "../Docker/DockerManager";
import {
  createPtyProcess,
  resizeTerminal,
  killTerminal,
} from "../terminal/pty";
import path from "path";
import { IPty } from "node-pty";
import { stopWatchingRoomFiles, watchRoomFiles } from "./watcher";

export class WebSocketService {
  public io: SocketServer;
  private dockerManager: DockerManager;
  private activeTerminals: Map<string, { pty: IPty; containerId: string }>;
  private roomUsers: Map<string, Set<string>>;
  private monitoredRooms: Set<string>;
  private heartbeatInterval: NodeJS.Timeout | null;

  constructor(server: HttpServer) {
    this.io = new SocketServer(server, { cors: { origin: "*" } });
    this.dockerManager = new DockerManager();
    this.activeTerminals = new Map();
    this.roomUsers = new Map();
    this.monitoredRooms = new Set();
    this.heartbeatInterval = null;

    // Start heartbeat to check container status
    this.startHeartbeat();

    this.io.on("connection", (socket: Socket) => {
      console.log(`👤 User connected: ${socket.id}`);

      socket.on("connect", () => {
        console.log(`✅ Socket connected: ${socket.id}`);
      });

      socket.on("joinRoom", async ({ roomId }) => {
        console.log(`👤 User ${socket.id} joining room: ${roomId}`);
        if (!this.roomUsers.has(roomId)) {
          this.roomUsers.set(roomId, new Set());
        }
        this.roomUsers.get(roomId)!.add(socket.id);
        socket.join(roomId);

        try {
          const container = await this.dockerManager.getContainer(roomId);
          if (!container?.id) {
            throw new Error(`🚨 Container not found for roomId: ${roomId}`);
          }
          socket.emit("roomJoined", { roomId, containerId: container.id });
          await watchRoomFiles(roomId);
          if (!this.monitoredRooms.has(roomId)) {
            this.dockerManager.monitorPorts(roomId, container.id);
            this.monitoredRooms.add(roomId);
          }
        } catch (error) {
          console.error("❌ Error in joinRoom:", error);
          socket.emit("error", "Failed to join room");
        }
      });

      socket.on("createTerminal", async ({ roomId, terminalId }) => {
        try {
          const container = await this.dockerManager.getContainer(roomId);
          if (!container?.id) {
            throw new Error(`🚨 Container not found for roomId: ${roomId}`);
          }
          const key = `${roomId}:${terminalId}`;

          // Check if terminal already exists for reconnect
          if (this.activeTerminals.has(key)) {
            console.log(`🔄 Reconnecting to existing terminal ${key}`);
            socket.emit("terminalCreated", { roomId, terminalId });
            return;
          }

          // Create new PTY
          const ptyProcess = await createPtyProcess(container.id);
          this.activeTerminals.set(key, {
            pty: ptyProcess,
            containerId: container.id,
          });
          console.log(
            `✅ Terminal created: ${key} | Container: ${container.id}`
          );

          ptyProcess.onData((data) => {
            // console.log(`[PTY Output ${key}]:`, JSON.stringify(data));
            this.io
              .to(roomId)
              .emit("terminal:output", { terminalId, data: data.toString() });
          });

          ptyProcess.onExit(({ exitCode }) => {
            console.log(`❌ PTY ${key} exited with code: ${exitCode}`);
            this.io.to(roomId).emit("terminal:exit", { terminalId });
            this.activeTerminals.delete(key);
          });

          socket.emit("terminalCreated", { roomId, terminalId });
        } catch (error) {
          console.error(`❌ Error creating terminal ${terminalId}:`, error);
          socket.emit("error", `Failed to create terminal ${terminalId}`);
        }
      });

      socket.on("terminal:write", ({ roomId, terminalId, data }) => {
        const key = `${roomId}:${terminalId}`;
        const terminal = this.activeTerminals.get(key);
        if (!terminal) {
          console.warn(`⚠️ No active PTY for ${key}`);
          socket.emit("error", `No terminal found for ${terminalId}`);
          return;
        }
        // console.log(`📥 Writing to ${key}:`, JSON.stringify(data));
        terminal.pty.write(data);
      });

      socket.on("terminal:resize", ({ roomId, terminalId, cols, rows }) => {
        const key = `${roomId}:${terminalId}`;
        const terminal = this.activeTerminals.get(key);
        if (!terminal) {
          console.warn(`⚠️ No active PTY for ${key}`);
          return;
        }
        if (!cols || !rows || cols < 10 || rows < 5) {
          console.warn(`⚠️ Ignoring invalid size for ${key}: ${cols}x${rows}`);
          return;
        }
        if (terminal.pty.cols !== cols || terminal.pty.rows !== rows) {
          console.log(`📏 Resizing PTY ${key} to ${cols}x${rows}`);
          resizeTerminal(terminal.pty, cols, rows);
        }
      });
      socket.on("run", async ({ containerId }) => {
        console.log("💻 Run triggered for container:", containerId);

        try {
          const result =
            await this.dockerManager.fileSystemService.execInContainer(
              containerId,
              "bash /runner.sh"
            );
          console.log("✅ Run completed:", result);
        } catch (error) {
          console.error("❌ Error running script in container:", error);
          socket.emit("run-error", { containerId, error: error });
        }
      });
      socket.on("stop", async ({ containerId }) => {
        console.log("💻 Run triggered for container:", containerId);

        try {
          const result =
            await this.dockerManager.fileSystemService.execInContainer(
              containerId,
              "kill $(cat /tmp/app.pid)"
            );
        } catch (error) {
          console.error("❌ Error stopping in container:", error);
          socket.emit("run-error", { containerId, error: error });
        }
      });

      socket.on("disconnect", async () => {
        console.log(`❌ User ${socket.id} disconnected`);
        this.roomUsers.forEach((users, roomId) => {
          if (users.has(socket.id)) {
            users.delete(socket.id);
            // Doesn’t kill PTYs here; let heartbeat handle cleanup
            if (users.size === 0) {
              console.log(
                `🛑 No more users in room ${roomId}, awaiting heartbeat cleanup`
              );
              this.roomUsers.delete(roomId);
              this.monitoredRooms.delete(roomId);
              stopWatchingRoomFiles(roomId);
            }
          }
        });
      });
    });
  }

  private async startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      console.log(
        `🩺 Running heartbeat check for ${this.activeTerminals.size} terminals`
      );
      for (const [key, { pty, containerId }] of this.activeTerminals) {
        const [roomId, terminalId] = key.split(":");
        try {
          const container = this.dockerManager.docker.getContainer(containerId);
          await container.inspect();
          console.log(
            `✅ Container ${containerId} for terminal ${key} is running`
          );
        } catch (err) {
          console.warn(
            `❌ Container ${containerId} for terminal ${key} not found, cleaning up`
          );
          killTerminal(pty);
          this.activeTerminals.delete(key);
          this.io.to(roomId).emit("terminal:exit", { terminalId });
        }
      }
    }, 30000); // 30 sec health check
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log(`🛑 Heartbeat stopped`);
    }
  }

  public async emitToRoom(roomId: string, event: string, tree: any) {
    const sanitizedRoomId = path.basename(roomId);
    console.log("Emitting directory update:", sanitizedRoomId, tree);

    if (!tree) {
      console.warn("Warning: Empty file tree");
      return;
    }

    this.io.to(sanitizedRoomId).emit("directory:changed", tree);
  }

  // Cleanup on server shutdown
  public async shutdown() {
    this.stopHeartbeat();
    for (const [key, { pty }] of this.activeTerminals) {
      killTerminal(pty);
      this.activeTerminals.delete(key);
    }
    console.log(`🧹 WebSocketService shutdown complete`);
  }
}
