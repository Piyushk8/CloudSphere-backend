
# 🌐 Cloud IDE

A **cloud-based collaborative IDE** that supports real-time terminal access, file editing, and Docker-isolated execution per user. Built for PERN projects and more, with support for web preview, file syncing, collaboration, and real-time terminal.

---

## 📁 Project Structure

```
cloud-ide/
├── backend/
│   ├── Docker/                  # Docker container orchestration
│   ├── services/                # File tree, terminal, exec services
│   ├── sockets/                 # WebSocket communication (Socket.io)
│   ├── utils/                   # In-container file watcher, debounce, etc.
│   ├── DockerManager.ts         # Container lifecycle and interaction
│   └── server.ts                # Express server + WebSocket setup
├── frontend/
│   ├── src/
│   │   ├── components/          # File tree, terminal, editor
│   │   ├── context/             # Room & Socket context
│   │   ├── hooks/               # Custom logic for terminal, file sync
│   │   └── App.tsx              # Main app
│   └── vite.config.ts           # Vite + proxy config
├── docker-compose.yml
├── nginx.conf                   # Reverse proxy config
└── README.md
```

---

## 🔧 Backend

### 🧱 Features

- One Docker container per user/room
- Terminal powered by `node-pty` & xterm.js
- Real-time collaboration with Socket.IO
- File syncing via in-container `inotifywait`
- File persistnace and storage on S3 bucket
- Dynamic port detection for running apps (React, Express, etc.)
- Reverse proxy support via Nginx

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

## 🌐 Nginx 

1. **Proxy Vite (5173), API (3001), and dynamic app ports**
2. Example location block:

```nginx
location / {
  proxy_pass http://localhost:5173;
}

location /api/ {
  proxy_pass http://localhost:3001;
}

location /app/ {
  proxy_pass http://localhost:49153;  # Sample exposed container port
}
```

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
- **DevOps:** Nginx, Docker Compose
