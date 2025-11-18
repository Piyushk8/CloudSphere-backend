// Request Body Typesexpo
export interface CreateRoomBody {
  language: string;
}

export interface ReadFileBody {
  roomId: string;
  path: string;
}

export interface SaveFileBody {
  roomId: string;
  path: string;
  content: string;
}

export interface CreatePathBody {
  roomId: string;
  path: string;
}

export interface RenamePathBody {
  roomId: string;
  oldPath: string;
  newPath: string;
}

import express, { Request, Response } from "express";
const app = express();

app.get("/test", async(req:Request, res:Response) => {
  res.send("ok");
});

