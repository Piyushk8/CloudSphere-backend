import { Server as SocketServer, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { DockerManager } from "../Docker/DockerManager";
import { createPtyProcess, resizeTerminal, killTerminal } from "../terminal/pty";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { IPty } from "node-pty";

const execPromise = promisify(exec);

export class WebSocketService {
  public io: SocketServer;
  private dockerManager: DockerManager;
  private activeTerminals: Map<string, IPty>;
  private roomUsers: Map<string, Set<string>>;
  private monitoredRooms: Set<string>; // Track rooms with active monitoring

  constructor(server: HttpServer) {
    this.io = new SocketServer(server, { cors: { origin: "*" } });
    this.dockerManager = new DockerManager();
    this.activeTerminals = new Map();
    this.roomUsers = new Map();
    this.monitoredRooms = new Set(); // Prevent duplicate monitoring

    this.io.on("connection", (socket: Socket) => {
      console.log(`👤 User connected: ${socket.id}`);

      socket.on("createRoom", async ({ image = "node:18" }) => {
        try {
          const roomId = `room-${Date.now()}`;
          const { containerId, hostPort } = await this.dockerManager.createContainer({
            image,
            roomId,
            exposedPort: 8080,
          });
          socket.emit("roomCreated", { roomId, containerId, hostPort });
          console.log(`✅ Room created: ${roomId} | Container: ${containerId}`);
        } catch (error) {
          console.error("❌ Error creating room:", error);
          socket.emit("error", "Failed to create room");
        }
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

          // Start port monitoring if not already active
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
          if (!this.activeTerminals.has(key)) {
            const ptyProcess = await createPtyProcess(container.id);
            this.activeTerminals.set(key, ptyProcess);

            ptyProcess.onData((data) => {
              console.log(`[PTY Output ${key}]:`, JSON.stringify(data));
              this.io.to(roomId).emit("terminal:output", { terminalId, data: data.toString() });
            });

            ptyProcess.onExit(({ exitCode }) => {
              console.log(`❌ PTY ${key} exited with code: ${exitCode}`);
              this.io.to(roomId).emit("terminal:exit", { terminalId });
              this.activeTerminals.delete(key);
            });

            // ptyProcess.on("error", (error) => {
            //   console.error(`❌ PTY ${key} error:`, error);
            //   socket.emit("error", `Terminal ${terminalId} encountered an error`);
            // });

            console.log(`✅ Terminal ${key} created`);
          }
          socket.emit("terminalCreated", { roomId, terminalId });
        } catch (error) {
          console.error(`❌ Error creating terminal ${terminalId}:`, error);
          socket.emit("error", `Failed to create terminal ${terminalId}`);
        }
      });

      socket.on("terminal:write", ({ roomId, terminalId, data }) => {
        const key = `${roomId}:${terminalId}`;
        const pty = this.activeTerminals.get(key);
        if (!pty) {
          console.warn(`⚠️ No active PTY for ${key}`);
          socket.emit("error", `No terminal found for ${terminalId}`);
          return;
        }
        console.log(`📥 Writing to ${key}:`, JSON.stringify(data));
        pty.write(data);
      });

      socket.on("terminal:resize", ({ roomId, terminalId, cols, rows }) => {
        const key = `${roomId}:${terminalId}`;
        const pty = this.activeTerminals.get(key);
        if (!pty) {
          console.warn(`⚠️ No active PTY for ${key}`);
          return;
        }
        if (!cols || !rows || cols < 10 || rows < 5) {
          console.warn(`⚠️ Ignoring invalid size for ${key}: ${cols}x${rows}`);
          return;
        }
        if (pty.cols !== cols || pty.rows !== rows) {
          console.log(`📏 Resizing PTY ${key} to ${cols}x${rows}`);
          resizeTerminal(pty, cols, rows);
        }
      });

      socket.on("disconnect", async () => {
        console.log(`❌ User ${socket.id} disconnected`);
        this.roomUsers.forEach((users, roomId) => {
          if (users.has(socket.id)) {
            users.delete(socket.id);
            if (users.size === 0) {
              console.log(`🛑 No more users in room ${roomId}, shutting down PTYs`);
              this.activeTerminals.forEach((pty, key) => {
                if (key.startsWith(`${roomId}:`)) {
                  killTerminal(pty);
                  this.activeTerminals.delete(key);
                }
              });
              this.roomUsers.delete(roomId);
              this.monitoredRooms.delete(roomId); // Cleanup monitoring
            }
          }
        });
      });
    });
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
}