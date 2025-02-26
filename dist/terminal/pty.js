"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resizeTerminal = void 0;
exports.createPtyProcess = createPtyProcess;
const node_pty_1 = require("node-pty");
function createPtyProcess(containerId) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            try {
                console.log(`🚀 Spawning PTY inside Docker container: ${containerId}`);
                const ptyProcess = (0, node_pty_1.spawn)("docker", [
                    "exec",
                    "-it",
                    containerId,
                    "/bin/bash",
                    "-c",
                    "cd /workspace && exec bash",
                ], {
                    name: "xterm-256color",
                    cols: 80,
                    rows: 30,
                    cwd: "/",
                    env: Object.assign(Object.assign({}, process.env), { TERM: "xterm-256color" }),
                });
                // ptyProcess.onData((data) => {
                //   console.log(`[PTY Docker Output]:`, JSON.stringify(data));
                // });
                ptyProcess.onExit(({ exitCode }) => {
                    console.log(`❌ PTY process inside Docker exited with code: ${exitCode}`);
                });
                resolve(ptyProcess);
            }
            catch (error) {
                console.error(`❌ Error creating PTY for container ${containerId}:`, error);
                reject(error);
            }
        });
    });
}
/**
 * 📌 Resize PTY process
 */
const resizeTerminal = (ptyProcess, cols, rows) => {
    if (ptyProcess) {
        console.log(`📏 [PTY] Resizing container terminal to ${cols}x${rows}`);
        ptyProcess.resize(cols, rows);
    }
};
exports.resizeTerminal = resizeTerminal;
