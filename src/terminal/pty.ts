import { spawn, IPty } from "node-pty"; // Ensure IPty is imported correctly

export async function createPtyProcess(containerId: string): Promise<IPty> {
  return new Promise((resolve, reject) => {
    try {
      console.log(`🚀 Spawning PTY inside Docker container: ${containerId}`);

      const ptyProcess = spawn(
        "docker",
        [
          "exec",
          "-it",
          containerId,
          "/bin/bash",
          "-c",
          "cd /workspace && exec bash",
        ],
        {
          name: "xterm-256color",
          cols: 80,
          rows: 30,
          cwd: "/",
          env: {
            ...process.env,
            TERM: "xterm-256color",
          },
        }
      );

      ptyProcess.onExit(({ exitCode }) => {
        console.log(`❌ PTY process inside Docker exited with code: ${exitCode}`);
      });

      resolve(ptyProcess);
    } catch (error) {
      console.error(`❌ Error creating PTY for container ${containerId}:`, error);
      reject(error);
    }
  });
}

export const resizeTerminal = (ptyProcess: IPty, cols: number, rows: number) => {
  if (ptyProcess) {
    console.log(`📏 [PTY] Resizing container terminal to ${cols}x${rows}`);
    ptyProcess.resize(cols, rows);
  }
};

export const killTerminal = (ptyProcess: IPty) => {
  if (ptyProcess) {
    ptyProcess.kill();
    console.log(`🛑 PTY terminated`);
  }
};