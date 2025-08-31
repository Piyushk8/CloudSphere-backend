
# 🌐 Cloud IDE
Think Replit, but with Docker containers, real file systems, and full-stack muscle.
This cloud-based collaborative IDE isn’t just for tinkering — it’s built for real development, with full support for:

🐳 Isolated Docker environments per user
🧠 PERN-ready (Postgres, Express, React, Node)
💻 Real-time terminal + Monaco code editing
🔄 Live file syncing from container to UI
🚀 Live preview for React, Express, or any app you spin up
🤝 Built-in collaboration (coming soon!)

It’s like hosting your own VS Code + Docker + Terminal + Preview in the cloud, minus the headaches. Whether you're prototyping a side project, teaching a bootcamp, or demoing an app.
---

# Demo video:
https://github.com/user-attachments/assets/7a3a354f-84b9-4b2b-90f2-58d57c3b8ee2

## 🔧 Backend

### 🧱 Features
- One Docker container per user/room
- Terminal powered by `node-pty` & xterm.js
- Real-time collaboration with Socket.IO
- File syncing via in-container `inotifywait`
- File persistnace and storage on S3 bucket
- Dynamic port detection for running apps (React, Express, etc.)
- Reverse proxy support via Traefik

### 🚀 Setup Instructions

1. **Install dependencies:**

```bash
cd backend
npm install
```

2. **Environment Variables (.env):**

```env
PORT=3001
DOCKER_SOCKET=/var/run/docker.sock
```

3. **Start the Backend:**

```bash
npm run dev
```

---

## 🐳 Docker-Based Room System

- Each user joins a room → spins up a Docker container.
- Room has:
  - PTY terminal (node-pty)
  - File system sync via `/workspace`
  - Isolated network environment

---

## 🔌 Key Backend APIs & Socket Events

### `POST /room/create`

Creates a Docker container for the user and returns:
```json
{
  "roomId": "abc123",
  "containerId": "f9bc...1234",
  "workspacePath": "/workspace"
}
```

### Socket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `joinRoom` | Client → Server | Joins a room |
| `terminal:input` | Client → Server | Sends terminal input |
| `terminal:output` | Server → Client | Returns terminal output |
| `directory:changed` | Server → Client | File tree changes (watched by inotify) |
| `active-ports` | Server → Client | Ports exposed inside container (React, Express, etc.) |

---

## 📦 Frontend

### 🧱 Features

- Monaco code editor
- Xterm.js terminal emulator
- File explorer synced to container's `/workspace`
- Preview window for React/Express apps
- Real-time collab ready *under-development

### 🚀 Setup Instructions

1. **Install frontend dependencies:**

```bash
cd frontend
npm install
```

2. **Start frontend dev server:**

```bash
npm run dev
```

Make sure backend is running and Vite proxy is configured to forward `/api` and WebSocket traffic.

---

## 🌐 Traefik Reverse Proxy

Traefik automatically detects running services and routes them based on labels in `docker-compose.yml`.

- Routes dev server (`5173`), API (`3001`), and dynamic preview ports
- Replace legacy NGINX config with label-based routing
- TLS + domain management (coming soon)


## ✅ To Do / Improvements

- [✅] In-container file watching with `inotifywait`
- [✅] WebSocket room system with PTY terminals
- [✅] Add project templates (e.g., Express, React)
- [✅] Workspace persistence (e.g., bind to volumes or S3)
- [✅] File system tree sync
- [❌] Docker container orchestration
- [❌] Rate limiting and auth for multi-user support

---

## 👨‍💻 Tech Stack

- **Frontend:** React, TypeScript, Vite, xterm.js, Monaco Editor
- **Backend:** Node.js, Express, Dockerode, Socket.IO
- **Docker Runtime:** Isolated per room
- **DevOps:** Traefik, Docker Compose
