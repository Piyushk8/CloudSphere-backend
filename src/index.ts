import http from "http"
import { WebSocketService } from "./Websocket/WebsocketService"
import { HttpService } from "./http/HttpService"
// import { listBuckets } from "./AWS";

const HttpServiceInstance = new HttpService()
const server = http.createServer(HttpServiceInstance.app);
export const webSocketServiceInstance = new WebSocketService(server)
// ✅ Fix CORS in Express Middleware



server.listen(4000,()=>{
    console.log("✅ server running on port",4000)
})

