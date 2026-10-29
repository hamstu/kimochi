import net from "node:net";

// Fixed loopback port makes independently launched runners mutually exclusive,
// even with different evidence directories. Windows releases it on process exit.
export async function acquireDesktop(port = 19334) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new Error(
          `Cannot lease desktop; another runner may be active: ${error.message}`,
        ),
      ),
    );
    server.listen({ port, host: "127.0.0.1", exclusive: true }, resolve);
  });
  server.unref();
  return server;
}
