import express, { Application, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import { DockerManager, ContainerOptions } from "../Docker/DockerManager";
import { randomUUID } from "crypto";
import { createServer } from "http";
import { WebSocketService } from "../Websocket/WebsocketService";
import { exec } from "child_process";
import { promisify } from "util";
import {unlinkSync, writeFileSync} from "fs"
import {  watchRoomFiles } from "../Websocket/Filewatcher";
import axios from "axios";

const app = express();
const execPromise = promisify(exec);

app.use(express.json());

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
    //@ts-ignore
    // this.app.get("/files/:roomId",async (req: Request, res: Response): Promise<Response> => {
    //     try {
    //       const { roomId } = req.params;
    //       // const container = await this.dockerManager.getContainer(roomId);

    //       // if (!container) {
    //       //   return res.status(404).json({ error: "Container not found" });
    //       // }
    //       const fileTree = await this.dockerManager.getFileTree(roomId);
    //       console.log(fileTree)
    //       const transformedTree = assignIds(fileTree);
    //       res.json({
    //         transformedTree,
    //       });
    //     } catch (error) {
    //       console.error("Error fetching file tree:", error);
    //       return res
    //         .status(500)
    //         .json({ error: "Failed to fetch file structure" });
    //     }
    //   }
    // );
    this.app.get("/files/:roomId", async (req, res) => {
      try {
        const { roomId } = req.params;
        const fileTree = await this.dockerManager.getFileTree(roomId);
        console.log("filetree",fileTree)
        // Start watching the room’s files if not already watched
        watchRoomFiles(roomId);
    
        res.json({ transformedTree: assignIds(fileTree) });
      } catch (error) {
        console.error("Error fetching file tree:", error);
        res.status(500).json({ error: "Failed to fetch file structure" });
      }
    });
    

    // ✅ Create Room with User-selected Programming Language
    //@ts-ignore
    this.app.post("/createRoom", async (req: Request, res: Response) => {
      // User selects a language
      try {
        const { language } = req.body; // User selects a language
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
        const workspacePath = path.resolve("storage", roomId);

        // Create workspace directory
        await fs.mkdir(workspacePath, { recursive: true });

        const containerOptions: ContainerOptions = {
          image: "node:18", // Default to Node.js, or use selected language
          roomId,
          exposedPort: 8080, // Example port
          envVars: ["NODE_ENV=development"], // Adjust for other languages
        };

        const { containerId, hostPort } =
          await this.dockerManager.createContainer(containerOptions);

        if (!containerId || !hostPort) return res.json({});
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

    this.app.post(
      "/read-file",
      async (req: Request, res: Response): Promise<void> => {
        try {
          // const {path:filePath} = req.query
          const { containerId, path: filePath } = req.body;

          if (!filePath || !containerId) {
            res.status(400).json({ error: "Invalid file path or containerId" });
            return;
          }

          console.log("Checking file:", filePath, "in container:", containerId);

          const checkCommand = `docker exec ${containerId} test -f ${filePath} && echo "file" || echo "directory"`;

          exec(checkCommand, (error, stdout, stderr) => {
            if (error) {
              console.error("Error checking file type:", error);
              res.status(500).json({ error: "Failed to check file type" });
              return;
            }

            const trimmedOutput = stdout.trim().replace(/['"]+/g, ""); // ✅ Fix extra quotes
            console.log("File type check output:", trimmedOutput);

            if (trimmedOutput === "directory") {
              res
                .status(400)
                .json({ error: "Path is a directory, not a file" });
              return;
            }

            if (trimmedOutput === "file") {
              const command = `docker exec ${containerId} cat ${filePath}`;
              console.log("Executing command:", command); // ✅ Log command for debugging

              exec(command, (error, stdout, stderr) => {
                if (error) {
                  console.error("Error executing command:", error);
                  res
                    .status(500)
                    .json({ error: "Failed to read file from container" });
                  return;
                }
                if (stderr) {
                  console.error("Error output:", stderr);
                  res.status(500).json({ error: stderr });
                  return;
                }

                console.log("File content read successfully");
                res.json({ content: stdout });
              });
            } else {
              res
                .status(500)
                .json({
                  error: `Unexpected output when checking file type: ${trimmedOutput}`,
                });
            }
          });
        } catch (error) {
          console.error("Unexpected error:", error);
          res.status(500).json({ error: "Failed to read file" });
        }
      }
    );

    //@ts-ignore
    this.app.post("/save-file", async (req: Request, res: Response) => {
      try {
        const { containerId, path: filePath, content } = req.body;
    
        if (!containerId || !filePath || typeof content !== "string") {
          return res.status(400).json({ error: "Invalid parameters" });
        }
    
        // Step 1: Ensure directory exists inside container
        const dirPath = path.dirname(filePath);
        await execPromise(`docker exec ${containerId} sh -c "mkdir -p '${dirPath}'"`);
    
        // Step 2: Save content to a temp file locally (base64 encoded)
        const tempFile = path.join(__dirname, "temp.b64");
        writeFileSync(tempFile, Buffer.from(content, "utf8").toString("base64"));
    
        // Step 3: Copy the base64 file to the container
        await execPromise(`docker cp ${tempFile} ${containerId}:/tmp/temp.b64`);
    
        // Step 4: Decode inside the container & move to destination
        await execPromise(`docker exec ${containerId} sh -c "base64 -d /tmp/temp.b64 > '${filePath}'"`);
    
        // Step 5: Cleanup local temp file
        unlinkSync(tempFile);
    
        res.json({ success: true });
    
      } catch (error: any) {
        console.error("Failed to write file inside container:", error);
        res.status(500).json({ error: "Failed to save file", details: error.message });
      }
    });
  
    this.app.use("/proxy/:roomId/:port", async (req, res) => {
      const { roomId, port } = req.params;
    
      try {
        const containerIP = await this.dockerManager.getContainerIP(roomId);
        if (!containerIP) throw new Error("Container IP not found");
        // console.log(containerIP)
        // console.log("getting process")
        const process = await this.dockerManager.getContainerProcesses(roomId)
        // console.log('get process result ',process)
        // console.log(this.dockerManager.parseListeningProcesses)
        const targetUrl = `http://${containerIP}:${port}${req.url}`;
        console.log("Proxying to:", targetUrl);
    
        // const response = await axios.get(targetUrl, { responseType: "stream" });
        // response.data.pipe(res);
      } catch (err) {
        console.error("Proxy Error:", err);
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

// 🔹 Supported Languages & Their Configurations
function getLanguageConfig(language: string) {
  const config: Record<
    string,
    { image: string; port: number; envVars?: string[] }
  > = {
    node: { image: "node:18", port: 8080, envVars: ["NODE_ENV=development"] },
    javascript: {
      image: "node:18",
      port: 8080,
      envVars: ["NODE_ENV=development"],
    },
    python: {
      image: "python:3.10",
      port: 5000,
      envVars: ["FLASK_ENV=development"],
    },
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

function assignIds(tree: any, idCounter = { value: 1 }): any {
  return tree.map((node: any) => {
    const newNode = {
      id: String(idCounter.value++), // Ensure each node has a unique ID
      name: node.name,
      path: node.path,
      type: node.type,
      children: node.children ? assignIds(node.children, idCounter) : undefined,
    };
    return newNode;
  });
}
