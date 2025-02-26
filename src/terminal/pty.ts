import { spawn, IPty } from "node-pty";

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

      // ptyProcess.onData((data) => {
      //   console.log(`[PTY Docker Output]:`, JSON.stringify(data));
      // });

      ptyProcess.onExit(({ exitCode }) => {
        console.log(
          `❌ PTY process inside Docker exited with code: ${exitCode}`
        );
      });

      resolve(ptyProcess);
    } catch (error) {
      console.error(
        `❌ Error creating PTY for container ${containerId}:`,
        error
      );
      reject(error);
    }
  });
}

/**
 * 📌 Resize PTY process
 */
export const resizeTerminal = (
  ptyProcess: IPty,
  cols: number,
  rows: number
) => {
  if (ptyProcess) {
    console.log(`📏 [PTY] Resizing container terminal to ${cols}x${rows}`);
    ptyProcess.resize(cols, rows);
  }
};
