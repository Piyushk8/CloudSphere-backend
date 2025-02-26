// WebSocketService.ts
import { Server as SocketServer, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { DockerManager } from "../Docker/DockerManager";
import { createPtyProcess } from "../terminal/pty";

export class WebSocketService {
  private io: SocketServer;
  private dockerManager: DockerManager;
  private activeTerminals: Map<string, any>; // Map roomId -> PTY process
  private roomUsers: Map<string, Set<string>>; // Map roomId -> Set of connected user IDs

  constructor(server: HttpServer) {
    this.io = new SocketServer(server, { cors: { origin: "*" } });
    this.dockerManager = new DockerManager();
    this.activeTerminals = new Map();
    this.roomUsers = new Map();

    this.io.on("connection", (socket: Socket) => {
      console.log(`User connected: ${socket.id}`);

      // Create a new room (workspace + container)
      socket.on("createRoom", async ({ image = "node:18" }) => {
        try {
          const roomId = `room-${Date.now()}`;
          const { containerId, hostPort } =
            await this.dockerManager.createContainer({
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

      // Join an existing room
      socket.on("joinRoom", async ({ roomId }) => {
        console.log(`👤 User ${socket.id} joining room: ${roomId}`);
        if (!this.roomUsers.has(roomId)) {
          this.roomUsers.set(roomId, new Set());
        }
        this.roomUsers.get(roomId)!.add(socket.id);

        if (!this.activeTerminals.has(roomId)) {
          try {
            const container = await this.dockerManager.getContainer(roomId);
            if (!container?.id)
              throw new Error(`🚨 Container not found for roomId: ${roomId}`);

            const ptyProcess = await createPtyProcess(container.id);
            this.activeTerminals.set(roomId, ptyProcess);
            console.log("🅿️pty process",ptyProcess)
            ptyProcess.onData((data) => {
              console.log("pty output",data)
              this.io.to(roomId).emit("terminal:output", data.toString());
            });
          } catch (error) {
            console.error("❌ Error setting up PTY:", error);
            socket.emit("error", "Failed to create terminal session");
            return;
          }
        } else {
          console.log(`🔄 Reattaching to existing terminal for room: ${roomId}`);
        }

        socket.join(roomId);

        socket.on("terminal:write", (data) => {
          if (this.activeTerminals.has(roomId)) {
            console.log(`📥 Received from frontend:`, JSON.stringify(data));
        
            // Ensure proper newline handling
            if (data === "\r") {
              data = "\n"; // Convert Carriage Return to Newline
            }
        
            this.activeTerminals.get(roomId).write(data);
          }
        });
        
        socket.on("terminal:resize", ({ cols, rows }) => {
          if (this.activeTerminals.has(roomId)) {
            this.activeTerminals.get(roomId).resize(cols, rows);
          }
        });

        // Handle user disconnect
        socket.on("disconnect", async () => {
          console.log(`❌ User ${socket.id} disconnected from room ${roomId}`);

          // this.roomUsers.get(roomId)?.delete(socket.id);
          // if (this.roomUsers.get(roomId)?.size === 0) {
          //   console.log(
          //     `🛑 No more users in room ${roomId}, shutting down PTY and container`
          //   );
          //   if (this.activeTerminals.has(roomId)) {
          //     this.activeTerminals.get(roomId).kill();
          //     this.activeTerminals.delete(roomId);
          //   }
          //   // await this.dockerManager.removeContainer(roomId);
          //   // this.roomUsers.delete(roomId);
          // }
        });
      });
    });
  }
}
