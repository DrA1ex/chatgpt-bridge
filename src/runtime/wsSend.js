// A slow or suspended subscriber can otherwise pin all queued buffers.
export function sendWebSocketFrame(socket, data, options) {
  if (socket.readyState !== 1) return false;
  const queued = socket.bufferedAmount;
  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  // A single large reply is supported. Reconnect if it leaves a backlog.
  if (queued && queued + size > 8 * 1024 * 1024) {
    socket.terminate();
    return false;
  }
  socket.send(data, options);
  return true;
}
