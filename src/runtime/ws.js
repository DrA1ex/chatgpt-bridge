import MiniWebSocket, { MiniWebSocketServer } from './miniWs.js';

let WebSocketRuntime = MiniWebSocket;
let WebSocketServerRuntime = MiniWebSocketServer;
try {
  const loaded = await import('ws');
  WebSocketRuntime = loaded.default || loaded.WebSocket || loaded;
  WebSocketServerRuntime = loaded.WebSocketServer;
} catch (error) {
  if (process.env.BRIDGE_REQUIRE_EXTERNAL_RUNTIME === '1') throw error;
}

export default WebSocketRuntime;
export const WebSocket = WebSocketRuntime;
export const WebSocketServer = WebSocketServerRuntime;
