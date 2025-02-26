import express, { Application, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import { DockerManager, ContainerOptions } from "../Docker/DockerManager";
import { randomUUID } from "crypto";
import { createServer } from "http";
import { WebSocketService } from "../Websocket/WebsocketService";

export class HttpService {
  public app: Application;
  private server;
  private websocketService: WebSocketService;
  private dockerManager: DockerManager;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.websocketService = new WebSocketService(this.server);
    this.dockerManager = new DockerManager();

    this.app.use(express.json());
    this.app.use(
      cors({
        origin: "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true,
      })
    );

    // ✅ Test API
    this.app.get("/", (req: Request, res: Response) => {
      res.json({ message: "Hello, Cloud IDE is running!" });
    });

    // ✅ Retrieve File Tree from Inside Docker Container
    this.app.get("/files/:roomId", async (req: Request, res: Response): Promise<Response> => {
      try {
        const { roomId } = req.params;
        const container = await this.dockerManager.getContainer(roomId);
    
        if (!container) {
          return res.status(404).json({ error: "Container not found" });
        }
    
        const exec = await container.exec({
          Cmd: ["sh", "-c", "ls -R /workspace"], // List files inside the container
          AttachStdout: true,
          AttachStderr: true,
        });
    
        const stream = await exec.start({});
        
        let output = "";
        stream.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
    
        stream.on("end", () => {
          return res.json({ fileTree: parseFileTree(output) }); // Ensure returning response
        });
    
      } catch (error) {
        console.error("Error fetching file tree:", error);
        return res.status(500).json({ error: "Failed to fetch file structure" });
      }
    });
    

    // ✅ Create Room with User-selected Programming Language
    this.app.post("/createRoom", async (req, res) => {
      try {
        const { language } = req.body; // User selects a language
        if (!language) {
          return res.status(400).json({ error: "Language selection is required" });
        }
    
        const languageConfig = getLanguageConfig(language);
        if (!languageConfig) {
          return res.status(400).json({ error: "Unsupported language" });
        }
    
        const roomId = `room-${Date.now()}-${randomUUID()}`;
        const workspacePath = path.resolve("storage", roomId);
    
        // Create workspace directory
        await fs.mkdir(workspacePath, { recursive: true });
    
        const containerOptions: ContainerOptions = {
          image: "node:18",  // Default to Node.js, or use selected language
          roomId,
          exposedPort: 8080,  // Example port
          envVars: ["NODE_ENV=development"],  // Adjust for other languages
        };
        
        const { containerId, hostPort } = await this.dockerManager.createContainer(containerOptions);
        
        if(!containerId || !hostPort) return res.json({})
        return res.json({
          message: "Room created successfully",
          roomId,
          containerId,
          hostPort,
          workspacePath,
        });
      } catch (error) {
        console.error("Error creating room:", error);
        return res.status(500).json({ error: "Failed to create room" });
      }
    });
    
  }

  start(port: number) {
    this.server.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
    });
  }
}

// 🔹 Supported Languages & Their Configurations
function getLanguageConfig(language: string) {
  const config: Record<string, { image: string; port: number; envVars?: string[] }> = {
    node: { image: "node:18", port: 8080, envVars: ["NODE_ENV=development"] },
    javascript: { image: "node:18", port: 8080, envVars: ["NODE_ENV=development"] },
    python: { image: "python:3.10", port: 5000, envVars: ["FLASK_ENV=development"] },
    java: { image: "openjdk:17", port: 8080, envVars: ["JAVA_OPTS=-Xmx512m"] },
    golang: { image: "golang:1.19", port: 8080, envVars: [] },
    rust: { image: "rust:latest", port: 8080, envVars: [] },
  };

  return config[language.toLowerCase()] || null;
}

// 🔹 Parse File Tree Output from Docker
function parseFileTree(output: string) {
  const tree: Record<string, any> = {};
  const lines = output.split("\n");
  let currentDir = tree;

  for (const line of lines) {
    if (line.endsWith(":")) {
      const pathParts = line.replace(":", "").split("/");
      currentDir = tree;
      for (const part of pathParts.slice(2)) {
        if (!currentDir[part]) currentDir[part] = {};
        currentDir = currentDir[part];
      }
    } else if (line.trim()) {
      currentDir[line.trim()] = null;
    }
  }

  return tree;
}
