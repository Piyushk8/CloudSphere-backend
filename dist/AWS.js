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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.s3Client = void 0;
exports.listBuckets = listBuckets;
exports.uploadFile = uploadFile;
exports.downloadFile = downloadFile;
exports.listFiles = listFiles;
exports.deleteFile = deleteFile;
const client_s3_1 = require("@aws-sdk/client-s3");
const client_s3_2 = require("@aws-sdk/client-s3");
const dotenv_1 = __importDefault(require("dotenv"));
const stream_1 = require("stream");
dotenv_1.default.config();
const credentials = {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY || "",
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_KEY || ""
};
exports.s3Client = new client_s3_2.S3Client({
    region: "auto",
    endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
    credentials: credentials
});
const BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET || "";
console.log(process.env.CLOUDFLARE_R2_ENDPOINT, process.env.CLOUDFLARE_R2_ACCESS_KEY, process.env.CLOUDFLARE_R2_SECRET_KEY, BUCKET_NAME);
function listBuckets() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const command = new client_s3_1.ListBucketsCommand({});
            const response = yield exports.s3Client.send(command);
            console.log("✅ Buckets:", response.Buckets);
            return response.Buckets;
        }
        catch (error) {
            console.error("❌ Error listing buckets:", error);
        }
    });
}
/**
 * Uploads a file to Cloudflare R2
 */
function uploadFile(key, content) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const command = new client_s3_1.PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
                Body: content,
            });
            yield exports.s3Client.send(command);
            console.log(`✅ File uploaded: ${key}`);
        }
        catch (error) {
            console.error(`❌ Error uploading file ${key}:`, error);
            throw error;
        }
    });
}
/**
 * Downloads a file from Cloudflare R2
 */
function downloadFile(key) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const command = new client_s3_1.GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
            });
            const { Body } = yield exports.s3Client.send(command);
            if (Body instanceof stream_1.Readable) {
                return yield streamToString(Body);
            }
            throw new Error("Invalid response body");
        }
        catch (error) {
            console.error(`❌ Error downloading file ${key}:`, error);
            throw error;
        }
    });
}
/**
 * Lists all files in the bucket
 */
function listFiles() {
    return __awaiter(this, arguments, void 0, function* (prefix = "") {
        try {
            const command = new client_s3_1.ListObjectsV2Command({
                Bucket: BUCKET_NAME,
                Prefix: prefix,
            });
            const { Contents } = yield exports.s3Client.send(command);
            return Contents ? Contents.map((item) => item.Key || "") : [];
        }
        catch (error) {
            console.error("❌ Error listing files:", error);
            throw error;
        }
    });
}
/**
 * Deletes a file from Cloudflare R2
 */
function deleteFile(key) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const command = new client_s3_1.DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
            });
            yield exports.s3Client.send(command);
            console.log(`✅ File deleted: ${key}`);
        }
        catch (error) {
            console.error(`❌ Error deleting file ${key}:`, error);
            throw error;
        }
    });
}
/**
 * Helper function to convert stream to string
 */
function streamToString(stream) {
    return new Promise((resolve, reject) => {
        let data = "";
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => resolve(data));
        stream.on("error", reject);
    });
}
