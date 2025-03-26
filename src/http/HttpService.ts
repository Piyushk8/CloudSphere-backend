import express, { Application, Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import { DockerManager, ContainerOptions } from "../Docker/DockerManager";
import { WebSocketService } from "../Websocket/WebsocketService";
import { watchRoomFiles, stopWatchingRoomFiles } from "../Websocket/Filewatcher";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { unlinkSync, writeFileSync } from "fs";

const execPromise = promisify(exec);

export class HttpService {
  public app: Application;
  private server: ReturnType<typeof createServer>;
  private websocketService: WebSocketService;
  private dockerManager: DockerManager;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.websocketService = new WebSocketService(this.server);
    this.dockerManager = new DockerManager();

    this.app.use(express.json());
    this.app.use(cors({ origin: "http://localhost:5173", methods: ["GET", "POST"], credentials: true }));

    // Test API
    this.app.get("/", (req: Request, res: Response) => {
      res.json({ message: "Hello, Cloud IDE is running!" });
    });

    // Retrieve File Tree
    //@ts-ignore
    this.app.get("/files/:roomId", async (req: Request, res: Response) => {
      try {
        const { roomId } = req.params;
        const fileTree = await this.dockerManager.getFileTree(roomId);
        if (!fileTree || fileTree.length === 0) {
          return res.status(404).json({ error: "No file tree found for room" });
        }

        // Start watching files (will skip if already watching)
        await watchRoomFiles(roomId);

        const transformedTree = assignIds(fileTree);
        res.json({ transformedTree });
      } catch (error) {
        console.error("Error fetching file tree:", error);
        res.status(500).json({ error: "Failed to fetch file structure" });
      }
    });

    // Create Room
    //@ts-ignore
    this.app.post("/createRoom", async (req: Request, res: Response) => {
      try {
        const { language } = req.body;
        if (!language) {
          return res.status(400).json({ error: "Language selection is required" });
        }
        
        const languageConfig = getLanguageConfig(language);
        if (!languageConfig) {
          return res.status(400).json({ error: "Unsupported language" });
        }
        
        const roomId = `room-${Date.now()}-${randomUUID()}`;
        const workspacePath = path.resolve("storage", roomId);
        await fs.mkdir(workspacePath, { recursive: true });
        
        const containerOptions: ContainerOptions = {
          image: languageConfig.image,
          roomId,
          exposedPort: languageConfig.port,
          envVars: languageConfig.envVars,
        };
        
        const { containerId, hostPort } = await this.dockerManager.createContainer(containerOptions);
        if (!containerId || !hostPort) {
          return res.status(500).json({ error: "Failed to create container" });
        }
        
        res.json({ message: "Room created successfully", roomId, containerId, hostPort, workspacePath });
      } catch (error) {
        console.error("Error creating room:", error);
        res.status(500).json({ error: "Failed to create room" });
      }
    });

    // Read File
    //@ts-ignore
    this.app.post("/read-file", async (req: Request, res: Response) => {
      try {
        const { containerId, path: filePath } = req.body;
        if (!filePath || !containerId) {
          return res.status(400).json({ error: "Invalid file path or containerId" });
        }

        const checkOutput = await execPromise(
          `docker exec ${containerId} sh -c "[ -f '${filePath}' ] && echo file || ([ -d '${filePath}' ] && echo directory || echo notfound)"`
        );
        const fileType = checkOutput.stdout.trim();

        if (fileType === "directory") {
          return res.status(400).json({ error: "Path is a directory, not a file" });
        }
        if (fileType === "notfound") {
          return res.status(404).json({ error: "File not found" });
        }

        const content = await execPromise(`docker exec ${containerId} cat '${filePath}'`);
        res.json({ content: content.stdout });
      } catch (error) {
        console.error("Error reading file:", error);
        res.status(500).json({ error: "Failed to read file" });
      }
    });

    // Save File
    //@ts-ignore
    this.app.post("/save-file", async (req: Request, res: Response) => {
      try {
        const { containerId, path: filePath, content } = req.body;
        if (!containerId || !filePath || typeof content !== "string") {
          return res.status(400).json({ error: "Invalid parameters" });
        }

        const dirPath = path.dirname(filePath);
        await execPromise(`docker exec ${containerId} mkdir -p '${dirPath}'`);

        const tempFile = path.join(__dirname, "temp.txt");
        writeFileSync(tempFile, content, "utf8");
        await execPromise(`docker cp ${tempFile} ${containerId}:'${filePath}'`);
        unlinkSync(tempFile);

        res.json({ success: true });
      } catch (error) {
        console.error("Failed to save file:", error);
        res.status(500).json({ error: "Failed to save file", details: (error as Error).message });
      }
    });

    // Proxy Route (Simplified, assuming completion elsewhere)
    this.app.use("/proxy/:roomId/:port", async (req, res) => {
      try {
        const { roomId, port } = req.params;
        const containerIP = await this.dockerManager.getContainerIP(roomId);
        if (!containerIP) throw new Error("Container IP not found");
        res.status(501).send("Proxy not fully implemented");
      } catch (error) {
        console.error("Proxy error:", error);
        res.status(500).send("Proxy error");
      }
    });
  }

  start(port: number) {
    this.server.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
    });
  }
}

// Language Configurations
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

// Assign IDs to File Tree
function assignIds(tree: any[], idCounter = { value: 1 }): any[] {
  return tree.map((node) => ({
    id: node.id || String(idCounter.value++),
    name: node.name,
    path: node.path,
    type: node.type,
    children: node.children ? assignIds(node.children, idCounter) : undefined,
  }));
}