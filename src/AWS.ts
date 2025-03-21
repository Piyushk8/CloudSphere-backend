// import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
// import { S3Client } from "@aws-sdk/client-s3";
// import dotenv from "dotenv";
// import { Readable, Stream } from "stream";

// dotenv.config();

// const credentials = {
//     accessKeyId:process.env.CLOUDFLARE_R2_ACCESS_KEY||"",
//     secretAccessKey:process.env.CLOUDFLARE_R2_SECRET_KEY||""
//   }
 
// export  const s3Client = new S3Client({
//   region: "auto",
//   endpoint:process.env.CLOUDFLARE_R2_ENDPOINT,
//   credentials:credentials

// })
// const BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET || "";

// console.log( process.env.CLOUDFLARE_R2_ENDPOINT,
//      process.env.CLOUDFLARE_R2_ACCESS_KEY,
//     process.env.CLOUDFLARE_R2_SECRET_KEY,
// BUCKET_NAME
//     )

  
  
    
    
//     export async function listBuckets() {
//         try {
//             const command = new ListBucketsCommand({});
//             const response = await s3Client.send(command);
//             console.log("✅ Buckets:", response.Buckets);
//             return response.Buckets;
//         } catch (error) {
//             console.error("❌ Error listing buckets:", error);
//         }
//     }
    
//     /**
//      * Uploads a file to Cloudflare R2
//      */
//     export async function uploadFile(key: string, content: Buffer | string): Promise<void> {
//       try {
//         const command = new PutObjectCommand({
//           Bucket: BUCKET_NAME,
//           Key: key,
//           Body: content,
//         });
    
//         await s3Client.send(command);
//         console.log(`✅ File uploaded: ${key}`);
//       } catch (error) {
//         console.error(`❌ Error uploading file ${key}:`, error);
//         throw error;
//       }
//     }
    
//     /**
//      * Downloads a file from Cloudflare R2
//      */
//     export async function downloadFile(key: string): Promise<string> {
//       try {
//         const command = new GetObjectCommand({
//           Bucket: BUCKET_NAME,
//           Key: key,
//         });
    
//         const { Body } = await s3Client.send(command);
//         if (Body instanceof Readable) {
//           return await streamToString(Body);
//         }
    
//         throw new Error("Invalid response body");
//       } catch (error) {
//         console.error(`❌ Error downloading file ${key}:`, error);
//         throw error;
//       }
//     }
    
//     /**
//      * Lists all files in the bucket
//      */
//     export async function listFiles(prefix: string = ""): Promise<string[]> {
//       try {
//         const command = new ListObjectsV2Command({
//           Bucket: BUCKET_NAME,
//           Prefix: prefix,
//         });
    
//         const { Contents } = await s3Client.send(command);
//         return Contents ? Contents.map((item) => item.Key || "") : [];
//       } catch (error) {
//         console.error("❌ Error listing files:", error);
//         throw error;
//       }
//     }
    
//     /**
//      * Deletes a file from Cloudflare R2
//      */
//     export async function deleteFile(key: string): Promise<void> {
//       try {
//         const command = new DeleteObjectCommand({
//           Bucket: BUCKET_NAME,
//           Key: key,
//         });
    
//         await s3Client.send(command);
//         console.log(`✅ File deleted: ${key}`);
//       } catch (error) {
//         console.error(`❌ Error deleting file ${key}:`, error);
//         throw error;
//       }
//     }
    
//     /**
//      * Helper function to convert stream to string
//      */
//     function streamToString(stream: Readable): Promise<string> {
//       return new Promise((resolve, reject) => {
//         let data = "";
//         stream.on("data", (chunk) => (data += chunk));
//         stream.on("end", () => resolve(data));
//         stream.on("error", reject);
//       });
//     }
    