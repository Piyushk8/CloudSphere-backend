# CloudIDE

A cloud-based collaborative IDE designed for real-world development. Similar in spirit to Replit, but built on isolated Docker containers with real file systems and full-stack support.

This platform is intended for serious development workflows, not just experimentation. It supports:

* Isolated Docker environments per user
* Full PERN stack support (Postgres, Express, React, Node.js)
* Integrated terminal and Monaco-based code editor
* Live file synchronization between container and UI
* Live preview for React, Express, or any running application
* Built-in collaboration (planned)

Effectively, this provides a hosted VS Code–like experience with Docker, terminal access, and live previews, without the operational overhead. It is suitable for prototyping, bootcamps, internal demos, and collaborative development.

---

## Demo Video

[https://github.com/user-attachments/assets/7a3a354f-84b9-4b2b-90f2-58d57c3b8ee2](https://github.com/user-attachments/assets/7a3a354f-84b9-4b2b-90f2-58d57c3b8ee2)

---

## Backend

### Features

* One Docker container per user or room
* Terminal access powered by `node-pty` and xterm.js
* Real-time communication via Socket.IO
* File system change detection using `inotifywait` inside containers
* File persistence backed by an S3-compatible storage layer
* Dynamic port detection for running services (React, Express, etc.)
* Reverse proxy support via Traefik

### Setup Instructions

1. **Install dependencies**

```bash
cd backend
npm install
```

2. **Environment variables (.env)**

```env
PORT=3001
DOCKER_SOCKET=/var/run/docker.sock
```

3. **Start the backend**

```bash
npm run dev
```

---

## Docker-Based Room System

* Each user joins a room, which provisions a dedicated Docker container.
* Each room includes:

  * A PTY-backed terminal
  * A synchronized workspace directory (`/workspace`)
  * An isolated network environment

---

## Key Backend APIs and Socket Events

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

| Event               | Direction       | Description                              |
| ------------------- | --------------- | ---------------------------------------- |
| `joinRoom`          | Client → Server | Join an existing room                    |
| `terminal:input`    | Client → Server | Send terminal input                      |
| `terminal:output`   | Server → Client | Stream terminal output                   |
| `directory:changed` | Server → Client | Notify UI of file system changes         |
| `active-ports`      | Server → Client | Report ports exposed by running services |

---

## Frontend

### Features

* Monaco-based code editor
* Terminal emulator using xterm.js
* File explorer synchronized with the container workspace
* Embedded preview window for React and Express applications
* Collaboration-ready architecture (in progress)

### Setup Instructions

1. **Install dependencies**

```bash
cd frontend
npm install
```

2. **Start the development server**

```bash
npm run dev
```

Ensure the backend is running and the Vite proxy is configured to forward API and WebSocket traffic.

---

## Traefik Reverse Proxy

Traefik automatically detects and routes services based on Docker labels defined in `docker-compose.yml`.

* Routes frontend, backend API, and dynamically exposed preview ports
* Replaces static NGINX configuration with label-based routing
* TLS and domain management planned for a future release

---

## Planned Improvements

* Completed:

  * In-container file watching
  * WebSocket-based room and terminal system
  * Project templates (React, Express)
  * Workspace persistence
  * File tree synchronization

* Pending:

  * Docker container orchestration and scaling
  * Authentication and rate limiting for multi-user environments

---

## Tech Stack

* **Frontend:** React, TypeScript, Vite, Monaco Editor, xterm.js
* **Backend:** Node.js, Express, Dockerode, Socket.IO
* **Runtime:** Docker (isolated per room)
* **Infrastructure:** Traefik, Docker Compose

If you want, I can also:

* Tighten this further for a **GitHub README**
* Rewrite it as a **product landing page**
* Convert it into **investor/demo documentation**
* Simplify it for **non-technical audiences**

Just tell me the target audience.
