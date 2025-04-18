import http from "http"
import { WebSocketService } from "./Websocket/WebsocketService"
import { HttpService } from "./http/HttpService"
// import { listBuckets } from "./AWS";

const HttpServiceInstance = new HttpService()
const server = http.createServer(HttpServiceInstance.app);
export const webSocketServiceInstance = new WebSocketService(server)



server.listen(4000,()=>{
    console.log("✅ server running on port",4000)
})

const Docker = require('dockerode');
const docker = new Docker();

// async function measureSpinUp(image = 'alpine:latest') {
//   const start = Date.now();
//   const container = await docker.createContainer({
//     Image: image,
//     Cmd: ['sh', '-c', 'while true; do sleep 1000; done'],
//   });
//   await container.start();
//   const end = Date.now();
//   await container.remove({ force: true });
//   return end - start;
// }

// (async () => {
//   const times = [];
//   for (let i = 0; i < 10; i++) {
//     times.push(await measureSpinUp('alpine:latest'));
//     times.push(await measureSpinUp('ubuntu:20.04')); // Compare
//   }
//   console.log('Alpine:', times.filter((_, i) => i % 2 === 0));
//   console.log('Ubuntu:', times.filter((_, i) => i % 2 === 1));
// })();
