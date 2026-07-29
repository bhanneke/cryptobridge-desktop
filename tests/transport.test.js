/* Transport seam tests.
 *
 * The security policy lives in Rust (src-tauri/src/proxy.rs, tested there);
 * this side is plumbing, so what matters here is that the plumbing does not
 * lose or misroute frames — particularly the race where a frame arrives before
 * the webview knows its socket id. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WebTransport,
  TauriTransport,
  tauriApi,
  pickTransport,
} from '../src/adapters/transport.js';

// --- fakes ------------------------------------------------------------------

/** A stand-in for the Tauri globals, recording call order. */
function fakeTauri({ onOpenInvoke } = {}) {
  const order = [];
  const calls = [];
  let handler = null;

  const core = {
    invoke: async (cmd, args) => {
      order.push(`invoke:${cmd}`);
      calls.push({ cmd, args });
      if (cmd === 'bisq_ws_open') {
        onOpenInvoke?.(emit);
        return 7;
      }
      if (cmd === 'bisq_http') return { status: 200, body: '{"ok":true}' };
      return null;
    },
  };
  const event = {
    listen: async (name, cb) => {
      order.push(`listen:${name}`);
      handler = cb;
      return () => {
        handler = null;
      };
    },
  };
  const emit = (payload) => handler?.({ payload });

  return { scope: { __TAURI__: { core, event } }, order, calls, emit };
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.last = this;
  }
  send(text) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

// --- selection --------------------------------------------------------------

test('pickTransport uses direct sockets in a plain browser', () => {
  const t = pickTransport({});
  assert.ok(t instanceof WebTransport);
  assert.equal(t.name, 'web');
});

test('pickTransport uses IPC when the Tauri globals are present', () => {
  const { scope } = fakeTauri();
  const t = pickTransport(scope);
  assert.ok(t instanceof TauriTransport);
  assert.equal(t.name, 'tauri-ipc');
});

test('a half-present Tauri global is not mistaken for the real thing', () => {
  assert.equal(tauriApi({ __TAURI__: {} }), null);
  assert.equal(tauriApi({ __TAURI__: { core: { invoke: () => {} } } }), null);
  assert.ok(pickTransport({ __TAURI__: { core: {} } }) instanceof WebTransport);
});

// --- TauriTransport ---------------------------------------------------------

test('request goes through invoke and returns status plus body', async () => {
  const { scope, calls } = fakeTauri();
  const t = pickTransport(scope);

  const res = await t.request('POST', 'http://127.0.0.1:8090/api/v1/trades', '{"a":1}');
  assert.deepEqual(res, { status: 200, body: '{"ok":true}' });
  assert.deepEqual(calls[0], {
    cmd: 'bisq_http',
    args: {
      method: 'POST', url: 'http://127.0.0.1:8090/api/v1/trades',
      body: '{"a":1}', headers: null,
    },
  });
});

test('a body-less request sends an explicit null, not undefined', async () => {
  const { scope, calls } = fakeTauri();
  await pickTransport(scope).request('GET', 'http://127.0.0.1:8090/api/v1/trades');
  assert.equal(calls[0].args.body, null);
});

test('a rejected invoke becomes an Error, not a bare string', async () => {
  const scope = {
    __TAURI__: {
      core: { invoke: async () => Promise.reject('host is not loopback') },
      event: { listen: async () => () => {} },
    },
  };
  await assert.rejects(
    () => pickTransport(scope).request('GET', 'http://evil.example/api/v1/x'),
    (err) => err instanceof Error && /not loopback/.test(err.message),
  );
});

test('the frame listener is registered before the socket is opened', async () => {
  const { scope, order } = fakeTauri();
  await pickTransport(scope).openSocket('ws://127.0.0.1:8090/websocket', {});
  assert.deepEqual(order, ['listen:bisq-ws', 'invoke:bisq_ws_open']);
});

test('frames reach the right handler and send/close carry the socket id', async () => {
  const { scope, calls, emit } = fakeTauri();
  const seen = [];
  const t = pickTransport(scope);

  const sock = await t.openSocket('ws://127.0.0.1:8090/websocket', {
    onMessage: (m) => seen.push(m),
  });

  emit({ id: 7, kind: 'message', data: '{"topic":"TRADE_PROPERTIES"}' });
  emit({ id: 999, kind: 'message', data: 'not ours' });
  assert.deepEqual(seen, ['{"topic":"TRADE_PROPERTIES"}']);

  sock.send('sub');
  sock.close();
  await Promise.resolve();
  assert.deepEqual(calls[1], { cmd: 'bisq_ws_send', args: { id: 7, text: 'sub' } });
  assert.deepEqual(calls[2], { cmd: 'bisq_ws_close', args: { id: 7 } });
});

test('a frame that arrives before the id gets back is buffered, not dropped', async () => {
  // The real race: the shell has completed the handshake and may already be
  // emitting while the invoke's resolution is still in flight to the webview.
  const { scope, emit } = fakeTauri({
    onOpenInvoke: (fire) => fire({ id: 7, kind: 'message', data: 'early' }),
  });
  const seen = [];
  await pickTransport(scope).openSocket('ws://127.0.0.1:8090/websocket', {
    onMessage: (m) => seen.push(m),
  });
  assert.deepEqual(seen, ['early'], 'the early frame should have been replayed');
  emit({ id: 7, kind: 'message', data: 'later' });
  assert.deepEqual(seen, ['early', 'later']);
});

test('close unregisters the handler so later frames are ignored', async () => {
  const { scope, emit } = fakeTauri();
  const seen = [];
  let closed = 0;
  await pickTransport(scope).openSocket('ws://127.0.0.1:8090/websocket', {
    onMessage: (m) => seen.push(m),
    onClose: () => closed++,
  });

  emit({ id: 7, kind: 'close' });
  emit({ id: 7, kind: 'message', data: 'after close' });
  assert.equal(closed, 1);
  assert.deepEqual(seen, []);
});

test('an error frame surfaces as an Error', async () => {
  const { scope, emit } = fakeTauri();
  const errors = [];
  await pickTransport(scope).openSocket('ws://127.0.0.1:8090/websocket', {
    onError: (e) => errors.push(e),
  });
  emit({ id: 7, kind: 'error', data: 'connection reset' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.match(errors[0].message, /connection reset/);
});

test('malformed frames are ignored rather than thrown', async () => {
  const { scope, emit } = fakeTauri();
  await pickTransport(scope).openSocket('ws://127.0.0.1:8090/websocket', {});
  assert.doesNotThrow(() => {
    emit(undefined);
    emit({ kind: 'message', data: 'no id' });
    emit({ id: 'seven', kind: 'message' });
  });
});

// --- WebTransport -----------------------------------------------------------

test('web request sets a JSON content-type only when there is a body', async () => {
  const seen = [];
  const scope = {
    fetch: async (url, init) => {
      seen.push({ url, init });
      return { status: 201, text: async () => 'created' };
    },
  };
  const t = new WebTransport(scope);

  const res = await t.request('POST', 'http://127.0.0.1:8090/api/v1/trades', '{"a":1}');
  assert.deepEqual(res, { status: 201, body: 'created' });
  assert.equal(seen[0].init.headers['content-type'], 'application/json');

  await t.request('GET', 'http://127.0.0.1:8090/api/v1/trades');
  assert.deepEqual(seen[1].init.headers, {});
  assert.equal(seen[1].init.body, undefined);
});

test('web openSocket resolves only once the socket is open', async () => {
  const t = new WebTransport({ WebSocket: FakeWebSocket });
  const seen = [];
  const pending = t.openSocket('ws://127.0.0.1:8090/websocket', {
    onMessage: (m) => seen.push(m),
  });

  const ws = FakeWebSocket.last;
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'must not resolve before the open event');

  ws.onopen();
  const sock = await pending;
  sock.send('sub');
  assert.deepEqual(ws.sent, ['sub']);

  ws.onmessage({ data: 'frame' });
  assert.deepEqual(seen, ['frame']);
});

test('web openSocket rejects when the socket never opens', async () => {
  const t = new WebTransport({ WebSocket: FakeWebSocket });
  const pending = t.openSocket('ws://127.0.0.1:9999/websocket', {});
  FakeWebSocket.last.onerror();
  await assert.rejects(() => pending, /failed/);
});

test('web openSocket reports a close that happens after opening', async () => {
  const t = new WebTransport({ WebSocket: FakeWebSocket });
  let closed = 0;
  const pending = t.openSocket('ws://127.0.0.1:8090/websocket', { onClose: () => closed++ });
  FakeWebSocket.last.onopen();
  await pending;
  FakeWebSocket.last.close();
  assert.equal(closed, 1);
});

test('web openSocket refuses when auth headers are required', async () => {
  // Bisq authenticates the WebSocket on handshake headers and neither a
  // browser's WebSocket nor Node's can set them. Failing loudly beats opening
  // a socket the node will reject for reasons nobody can see.
  const t = new WebTransport({ WebSocket: FakeWebSocket });
  await assert.rejects(
    () => t.openSocket('ws://127.0.0.1:8090/websocket', {
      headers: { 'Bisq-Client-Id': 'x', 'Bisq-Session-Id': 'y' },
    }),
    /cannot set WebSocket handshake headers/,
  );
});

test('tauri openSocket forwards auth headers to the shell', async () => {
  const { scope, calls } = fakeTauri();
  await pickTransport(scope).openSocket('ws://127.0.0.1:8090/websocket', {
    headers: { 'Bisq-Client-Id': 'cid', 'Bisq-Session-Id': 'sid' },
  });
  assert.deepEqual(calls[0], {
    cmd: 'bisq_ws_open',
    args: {
      url: 'ws://127.0.0.1:8090/websocket',
      headers: { 'Bisq-Client-Id': 'cid', 'Bisq-Session-Id': 'sid' },
    },
  });
});
