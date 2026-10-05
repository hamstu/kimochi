import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const compiled = await build({
  stdin: {
    contents: `export * from './frontend/texthooker/input-source'; export * from './frontend/texthooker/websocket-input';`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const {
  inputSourceOf,
  acceptsInput,
  socketText,
  socketUrl,
  connectTextSocket,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);

test("input migration preserves clipboard preference and never enables multiple sources", () => {
  assert.equal(inputSourceOf({}), "ocr");
  assert.equal(inputSourceOf({ clipboardEnabled: true }), "clipboard");
  assert.equal(
    inputSourceOf({ inputSource: "ocr", clipboardEnabled: true }),
    "ocr",
  );
  for (const inputSource of ["ocr", "clipboard", "websocket"]) {
    for (const source of ["ocr", "clipboard", "websocket", "webhook"]) {
      assert.equal(
        acceptsInput({ inputSource }, source),
        inputSource === source,
      );
    }
  }
});
test("WebSocket parser accepts text envelopes and ignores control/malformed/binary messages", () => {
  for (const text of ["猫", '"猫"', '{"text":"猫"}', '{"sentence":"猫"}'])
    assert.equal(socketText(text), "猫");
  for (const data of [
    "",
    "{broken",
    '{"status":"ready"}',
    new Uint8Array([1]),
    "x".repeat(1_000_001),
  ])
    assert.equal(socketText(data), null);
  assert.equal(socketUrl("ws://localhost:1234"), "ws://localhost:1234/");
  assert.throws(() => socketUrl("https://localhost"));
  assert.throws(() => socketUrl("ws://name:secret@localhost"));
});
test("socket disposal cancels reconnect and stale callbacks; retries have bounded backoff", () => {
  const sockets = [],
    timers = new Map(),
    delays = [],
    lines = [],
    statuses = [];
  let id = 0;
  const close = connectTextSocket(
    "ws://localhost:1234",
    (text) => lines.push(text),
    (status) => statuses.push(status.state),
    () => {
      const s = {
        close() {
          s.closed = true;
        },
      };
      sockets.push(s);
      return s;
    },
    {
      set(fn, ms) {
        delays.push(ms);
        timers.set(++id, fn);
        return id;
      },
      clear(key) {
        timers.delete(key);
      },
    },
  );
  const oldMessage = sockets[0].onmessage;
  for (let i = 0; i < 8; i++) {
    sockets.at(-1).onerror();
    const [key, fn] = [...timers][0];
    timers.delete(key);
    fn();
  }
  assert.deepEqual(
    delays,
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  );
  sockets.at(-1).onmessage({ data: "猫" });
  sockets.at(-1).onerror();
  close();
  oldMessage({ data: "late" });
  assert.deepEqual(lines, ["猫"]);
  assert.equal(timers.size, 0);
  assert.equal(sockets.filter((s) => !s.closed).length, 0);
});
test("real loopback WebSocket delivers Japanese text through the production client", async () => {
  const server = createServer();
  const connections = new Set();
  server.on("connection", (s) => {
    connections.add(s);
    s.on("close", () => connections.delete(s));
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(
        request.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const text = Buffer.from(JSON.stringify({ text: "猫が好きです" }));
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let dispose;
  try {
    const line = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("no text received")), 3000);
      dispose = connectTextSocket(
        `ws://127.0.0.1:${server.address().port}`,
        (text) => {
          clearTimeout(timeout);
          resolve(text);
        },
        () => {},
      );
    });
    assert.equal(line, "猫が好きです");
  } finally {
    dispose?.();
    for (const s of connections) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
