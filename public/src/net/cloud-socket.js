export function createCloudSocket(inviteCode) {
  const handlers = new Map();
  let ws;
  let closed = false;
  let retry = 500;
  const socket = {
    connected: false,
    on(event, callback) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(callback);
      return socket;
    },
    emit(event, payload) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, payload }));
    },
    disconnect() {
      closed = true;
      ws?.close();
    },
  };
  const notify = (event, payload) => {
    for (const callback of handlers.get(event) ?? []) callback(payload);
  };
  function open() {
    if (closed) return;
    const url = new URL('/api/socket', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('code', inviteCode);
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      socket.connected = true;
      retry = 500;
      notify('connect');
    });
    ws.addEventListener('message', ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (typeof message.event === 'string') notify(message.event, message.payload);
      } catch { /* Ignore malformed network data. */ }
    });
    ws.addEventListener('close', (event) => {
      socket.connected = false;
      notify('disconnect');
      if (event.code === 4403) {
        closed = true;
        notify('connect_error', new Error('Invalid invite code'));
      } else if (!closed) {
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 4000);
      }
    });
  }
  queueMicrotask(open);
  return socket;
}
