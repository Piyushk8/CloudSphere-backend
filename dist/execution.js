"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCode = runCode;
const child_process_1 = require("child_process");
function runCode(code) {
    return new Promise((resolve) => {
        (0, child_process_1.exec)(`node -e "${code}"`, (error, stdout, stderr) => {
            resolve({ output: stdout, error: stderr });
        });
    });
}
