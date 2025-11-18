import express, { Application, NextFunction, Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import { DockerManager, ContainerOptions } from "../Docker/DockerManager";
import { WebSocketService } from "../Websocket/WebsocketService";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import {
  copyFilesToContainer,
  copyFileToContainer,
  streamR2FilesToContainer,
  streamR2ZipToContainer,
} from "../AWS";
import path from "path";
import getLanguageConfig from "../lib/utils";
import {
  CreatePathBody,
  CreateRoomBody,
  ReadFileBody,
  RenamePathBody,
  SaveFileBody,
} from "./type";

dotenv.config();

export class HttpService {
  public app: express.Express;
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
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true,
      })
    );
    // this.app.use((req, res, next) => {
    //   res.header("Access-Control-Allow-Origin", "*");
    //   res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PUT,DELETE");
    //   res.header(
    //     "Access-Control-Allow-Headers",
    //     "Content-Type,Authorization,X-Requested-With"
    //   );
    //   if (req.method === "OPTIONS") {
    //     res.sendStatus(200);
    //   } else {
    //     next();
    //   }
    // });
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.get("/", (_req: Request, res: Response) => {
      res.json({ message: "Hello, Cloud IDE is running!" });
    });
    this.app.get("/files/:roomId", async (req, res) => {
      try {
        const { roomId } = req.params;
        const fileTree = await this.dockerManager.getFileTree(roomId);

        if (!fileTree || fileTree.length === 0) {
          res.status(404).json({ error: "No file tree found for room" });
          return;
        }

        const transformedTree = assignIds(fileTree);
        res.json({ transformedTree });
      } catch (err) {
        console.error("Error fetching file tree:", err);
        res.status(500).json({ error: "Failed to fetch file structure" });
      }
    });

    this.app.post(
      "/createRoom",
      async (req: Request<{}, {}, CreateRoomBody>, res: Response) => {
        try {
          const { language } = req.body;
          if (!language) {
            res.status(400).json({ error: "Language selection is required" });
            return;
          }

          const languageConfig = getLanguageConfig(language);
          if (!languageConfig) {
            res.status(400).json({ error: "Unsupported language" });
            return;
          }

          const roomId = `room-${Date.now()}-${randomUUID()}`;
          const containerOptions: ContainerOptions = {
            image: languageConfig.image,
            roomId,
            exposedPort: languageConfig.port,
            envVars: languageConfig.envVars,
          };

          const result = await this.dockerManager.createContainer(
            containerOptions
          );

          if (result instanceof Error) {
            console.error("Failed to create container:", result.message);
            res
              .status(500)
              .json({ success: false, error: "Container creation failed" });
            return;
          }

          const { containerId } = result;

          // Copy files into container
          if (
            ["reactjs", "nextjs", "expressjs"].includes(language.toLowerCase())
          ) {
            await streamR2ZipToContainer(
              process.env.CLOUDFLARE_R2_BUCKET!,
              languageConfig.zipKey,
              containerId
            );
          } else {
            await streamR2FilesToContainer(
              process.env.CLOUDFLARE_R2_BUCKET!,
              `base/${language}`,
              containerId,
              "/workspace"
            );
          }

          await copyFileToContainer(
            containerId,
            `./src/lib/ConfigFiles/${language}/run.config.json`,
            "/workspace"
          );
          await copyFileToContainer(containerId, `./src/lib/runner.sh`, "/");

          // Install deps (if any)
          if (languageConfig.installCommand) {
            await this.dockerManager.fileSystemService.execInContainer(
              containerId,
              languageConfig.installCommand
            );
          }

          res.json({
            success: true,
            message: "Room created successfully",
            roomId,
            containerId,
          });
          return;
        } catch (error) {
          console.error("❌ Error creating room:", error);
          res.status(500).json({ error: "Failed to create room" });
          return;
        }
      }
    );

    this.app.post(
      "/read-file",
      async (req: Request<{}, {}, ReadFileBody>, res: Response) => {
        try {
          const { roomId, path } = req.body;

          const content = await this.dockerManager.readFile(
            roomId,
            path.replace("/workspace/", "")
          );
          res.json({ content });
        } catch (error) {
          console.error("Error reading file:", error);
          res.status(500).json({ error: (error as Error).message });
        }
      }
    );

    this.app.post(
      "/save-file",
      async (req: Request<{}, {}, SaveFileBody>, res: Response) => {
        try {
          const { roomId, path, content } = req.body;

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
      }
    );

    this.app.post(
      "/create-file",
      async (req: Request<{}, {}, CreatePathBody>, res: Response) => {
        try {
          const { roomId, path } = req.body;

          await this.dockerManager.createFile(roomId, path);
          res.json({ success: true });
        } catch (error) {
          console.error("Error creating file:", error);
          res.status(500).json({ error: (error as Error).message });
        }
      }
    );

    this.app.post(
      "/create-folder",
      async (req: Request<{}, {}, CreatePathBody>, res: Response) => {
        try {
          const { roomId, path } = req.body;

          await this.dockerManager.createFolder(roomId, path);
          res.json({ success: true });
        } catch (error) {
          console.error("Error creating folder:", error);
          res.status(500).json({ error: (error as Error).message });
        }
      }
    );

    this.app.post(
      "/delete-path",
      async (req: Request<{}, {}, CreatePathBody>, res: Response) => {
        try {
          const { roomId, path } = req.body;

          await this.dockerManager.deletePath(roomId, path);
          res.json({ success: true });
        } catch (error) {
          console.error("Error deleting path:", error);
          res.status(500).json({ error: (error as Error).message });
        }
      }
    );

    this.app.post(
      "/rename-path",
      async (req: Request<{}, {}, RenamePathBody>, res: Response) => {
        try {
          const { roomId, oldPath, newPath } = req.body;

          await this.dockerManager.renamePath(roomId, oldPath, newPath);
          res.json({ success: true });
        } catch (error) {
          console.error("Error renaming path:", error);
          res.status(500).json({ error: (error as Error).message });
        }
      }
    );
  }

  start(port: number) {
    this.server.listen(port, () => {
      console.log(`Server running on port ${port}`);
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
