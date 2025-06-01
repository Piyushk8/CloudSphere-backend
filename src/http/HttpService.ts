import express, { Application, Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import { DockerManager, ContainerOptions } from "../Docker/DockerManager";
import { WebSocketService } from "../Websocket/WebsocketService";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { streamR2FilesToContainer } from "../AWS";
import path from "path";
import getLanguageConfig from "../lib/utils";

dotenv.config();

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
    this.app.use(
      cors({
        origin: "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true,
      })
    );

    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.get("/", (req: Request, res: Response) => {
      res.json({ message: "Hello, Cloud IDE is running!" });
    });
    //@ts-ignore
    this.app.get("/files/:roomId", async (req: Request, res: Response) => {
      try {
        const { roomId } = req.params;
        const fileTree = await this.dockerManager.getFileTree(roomId);
        if (!fileTree || fileTree.length === 0) {
          return res.status(404).json({ error: "No file tree found for room" });
        }
        const transformedTree = assignIds(fileTree);
        res.json({ transformedTree });
      } catch (error) {
        console.error("Error fetching file tree:", error);
        res.status(500).json({ error: "Failed to fetch file structure" });
      }
    });

    //@ts-ignore
    this.app.post("/createRoom", async (req: Request, res: Response) => {
      try {
        const { language } = req.body;
        if (!language) {
          return res
            .status(400)
            .json({ error: "Language selection is required" });
        }
        const languageConfig = getLanguageConfig(language);
        if (!languageConfig) {
          return res.status(400).json({ error: "Unsupported language" });
        }

        const roomId = `room-${Date.now()}-${randomUUID()}`;
        const containerOptions: ContainerOptions = {
          image: languageConfig.image,
          roomId,
          exposedPort: languageConfig.port,
          envVars: languageConfig.envVars,
        };
        const { containerId} =
          await this.dockerManager.createContainer(containerOptions);
        // const tempDirPath = path.resolve("temp", roomId);
        // Create a temporary directory to store files from R2
        // await fs.mkdir(tempDirPath, { recursive: true });

        // Download the files from the specified R2 bucket and folder
        await streamR2FilesToContainer(
          process.env.CLOUDFLARE_R2_BUCKET || "",
          `base/${language}`,
          containerId,
          "/workspace"
        );
        res.json({
          message: "Room created successfully",
          roomId,
          containerId,
        });
      } catch (error) {
        console.error("Error creating room:", error);
        res.status(500).json({ error: "Failed to create room" });
      }
    });

    //@ts-ignore
    this.app.post("/read-file", async (req: Request, res: Response) => {
      try {
        const { roomId, path } = req.body;
        if (!roomId || !path) {
          return res.status(400).json({ error: "Missing roomId or path" });
        }
        const content = await this.dockerManager.readFile(
          roomId,
          path.replace("/workspace/", "")
        );
        res.json({ content });
      } catch (error) {
        console.error("Error reading file:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    //@ts-ignore
    this.app.post("/save-file", async (req: Request, res: Response) => {
      try {
        const { roomId, path, content } = req.body;
        if (!roomId || !path || typeof content !== "string") {
          return res.status(400).json({ error: "Invalid parameters" });
        }
        await this.dockerManager.writeFile(
          roomId,
          path.replace("/workspace/", ""),
          content
        );
        res.json({ success: true });
      } catch (error) {
        console.error("Error saving file:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    //@ts-ignore
    this.app.post("/create-file", async (req: Request, res: Response) => {
      try {
        const { roomId, path } = req.body;
        if (!roomId || !path) {
          return res.status(400).json({ error: "Missing roomId or path" });
        }
        await this.dockerManager.createFile(roomId, path);
        res.json({ success: true });
      } catch (error) {
        console.error("Error creating file:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    //@ts-ignore
    this.app.post("/create-folder", async (req: Request, res: Response) => {
      try {
        const { roomId, path } = req.body;
        if (!roomId || !path) {
          return res.status(400).json({ error: "Missing roomId or path" });
        }
        await this.dockerManager.createFolder(roomId, path);
        res.json({ success: true });
      } catch (error) {
        console.error("Error creating folder:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    //@ts-ignore
    this.app.post("/delete-path", async (req: Request, res: Response) => {
      try {
        const { roomId, path } = req.body;
        if (!roomId || !path) {
          return res.status(400).json({ error: "Missing roomId or path" });
        }
        await this.dockerManager.deletePath(roomId, path);
        res.json({ success: true });
      } catch (error) {
        console.error("Error deleting path:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    });

    //@ts-ignore
    this.app.post("/rename-path", async (req: Request, res: Response) => {
      try {
        const { roomId, oldPath, newPath } = req.body;
        if (!roomId || !oldPath || !newPath) {
          return res
            .status(400)
            .json({ error: "Missing roomId, oldPath, or newPath" });
        }
        await this.dockerManager.renamePath(roomId, oldPath, newPath);
        res.json({ success: true });
      } catch (error) {
        console.error("Error renaming path:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    });
  }

  start(port: number) {
    this.server.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
    });
  }
}


function assignIds(tree: any[], idCounter = { value: 1 }): any[] {
  return tree.map((node) => ({
    id: node.id || String(idCounter.value++),
    name: node.name,
    path: node.path,
    type: node.type,
    children: node.children ? assignIds(node.children, idCounter) : undefined,
  }));
}
