import { socketText, socketUrl } from "./input-source";

export type SocketStatus = {
  state: "connecting" | "connected" | "retrying" | "invalid";
  message: string;
};
type Socket = Pick<
  WebSocket,
  "onopen" | "onmessage" | "onerror" | "onclose" | "close"
>;

/** One live socket, bounded reconnect delay, and no callbacks after disposal. */
export function connectTextSocket(
  address: string,
  onText: (text: string) => void,
  onStatus: (status: SocketStatus) => void,
  create: (url: string) => Socket = (url) => new WebSocket(url),
  // Wrapped, not passed bare: `timers.clear(t)` calls it with `timers` as `this`, which browsers
  // reject ("Illegal invocation"), so disconnecting threw before the caller cleared its status.
  timers = {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
): () => void {
  let stopped = false;
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let url: string;
  try {
    url = socketUrl(address);
  } catch {
    onStatus({
      state: "invalid",
      message: "Use a ws:// or wss:// address without credentials.",
    });
    return () => {};
  }
  const detach = (): void => {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
    socket = undefined;
  };
  const retry = (): void => {
    if (stopped || timer !== undefined) return;
    detach();
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
    onStatus({
      state: "retrying",
      message: `WebSocket unavailable. Retrying in ${delay / 1000}s.`,
    });
    timer = timers.set(() => {
      timer = undefined;
      connect();
    }, delay);
  };
  const connect = (): void => {
    if (stopped) return;
    onStatus({ state: "connecting", message: "Connecting to WebSocket…" });
    try {
      socket = create(url);
      socket.onopen = () => {
        if (stopped) return;
        failures = 0;
        onStatus({ state: "connected", message: "WebSocket connected" });
      };
      socket.onmessage = (event) => {
        if (stopped) return;
        const text = socketText(event.data);
        if (text) onText(text);
      };
      socket.onerror = retry;
      socket.onclose = retry;
    } catch {
      retry();
    }
  };
  connect();
  return () => {
    stopped = true;
    if (timer !== undefined) timers.clear(timer);
    detach();
  };
}
