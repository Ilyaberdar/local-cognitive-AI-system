import { Duplex } from "stream";
import type WebSocket from "ws";

/** A byte stream over a WebSocket, used as the transport under TLS. Writes become binary
 * messages of at most `maxMessage` bytes (TLS may coalesce records beyond the relay's limit);
 * a full read buffer pauses the socket, so backpressure reaches the relay. */
export const wsDuplex = (socket: WebSocket, maxMessage = 64 * 1024): Duplex => {
  const duplex = new Duplex({
    read() { socket.resume(); },
    write(chunk: Buffer, _encoding, callback) {
      const parts: Buffer[] = [];
      for (let offset = 0; offset < chunk.length; offset += maxMessage) parts.push(chunk.subarray(offset, offset + maxMessage));
      let left = parts.length, failed = false;
      if (!left) { callback(); return; }
      for (const part of parts) socket.send(part, { binary: true }, error => {
        if (failed) return;
        if (error) { failed = true; callback(error); return; }
        if (--left === 0) callback();
      });
    },
    final(callback) { socket.close(1000); callback(); },
    destroy(error, callback) { if (socket.readyState <= 1) socket.terminate(); callback(error); }
  });
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
    // Text messages are relay control frames; they never enter the TLS stream.
    if (!binary) return;
    const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (!duplex.push(chunk)) socket.pause();
  });
  socket.on("close", () => { duplex.push(null); });
  socket.on("error", error => { duplex.destroy(error); });
  return duplex;
};
