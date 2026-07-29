/* Transport seam for the BisqAdapter.
 *
 * The adapter needs to reach a Bisq node on 127.0.0.1, but the packaged app's
 * CSP holds `connect-src` at 'self' — so inside Tauri the webview cannot open
 * that socket at all. It asks the Rust shell to, over IPC.
 *
 * Two implementations, one interface:
 *
 *   WebTransport    fetch + WebSocket. Used when src/ is served in a plain
 *                   browser (`python3 -m http.server`), which is how the UI is
 *                   developed and how the e2e suite runs.
 *   TauriTransport  invoke('bisq_http' | 'bisq_ws_*') + a 'bisq-ws' event
 *                   stream. Used in the desktop app. The allowlisting that
 *                   makes this safe lives in src-tauri/src/proxy.rs — this
 *                   side is only plumbing and holds no policy.
 *
 * Interface:
 *   request(method, url, bodyText?) -> Promise<{ status, body }>
 *   openSocket(url, { onMessage, onError, onClose }) -> Promise<{ send, close }>
 *
 * openSocket resolves once the socket is *open* and rejects if it never opens,
 * so callers can subscribe immediately after awaiting it without racing the
 * handshake.
 */

/** Tauri rejects with a plain string; make it an Error like everything else. */
function asError(e) {
  return e instanceof Error ? e : new Error(String(e));
}

export class WebTransport {
  /** @param {object} scope  injectable for tests; defaults to the real global */
  constructor(scope = globalThis) {
    this.scope = scope;
    this.name = 'web';
  }

  async request(method, url, body, extraHeaders) {
    const headers = { ...(extraHeaders ?? {}) };
    if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
    const res = await this.scope.fetch(url, {
      method,
      headers,
      body: body ?? undefined,
    });
    return { status: res.status, body: await res.text() };
  }

  openSocket(url, handlers = {}) {
    return new Promise((resolve, reject) => {
      // Bisq authenticates the WebSocket on handshake headers, and neither a
      // browser's WebSocket nor Node's can set them. Say so plainly instead of
      // opening a connection that the node will just reject.
      if (handlers.headers && Object.keys(handlers.headers).length) {
        reject(new Error(
          'this transport cannot set WebSocket handshake headers, which an authenticated '
          + 'Bisq node requires — use the desktop app, whose Rust shell can',
        ));
        return;
      }
      let ws;
      try {
        ws = new this.scope.WebSocket(url);
      } catch (e) {
        reject(asError(e));
        return;
      }
      let opened = false;

      ws.onopen = () => {
        opened = true;
        resolve({
          send: (text) => ws.send(text),
          close: () => {
            try {
              ws.close();
            } catch {
              /* already closing */
            }
          },
        });
      };
      ws.onmessage = (e) => handlers.onMessage?.(String(e.data));
      ws.onerror = () => {
        if (opened) handlers.onError?.(new Error('websocket error'));
        else reject(new Error(`WebSocket to ${url} failed`));
      };
      ws.onclose = () => {
        if (opened) handlers.onClose?.();
        else reject(new Error(`WebSocket to ${url} closed before opening`));
      };
    });
  }
}

export class TauriTransport {
  /** @param {{invoke: Function, listen: Function}} api */
  constructor({ invoke, listen }) {
    this.invoke = invoke;
    this.listen = listen;
    this.name = 'tauri-ipc';
    this.handlers = new Map(); // socket id -> handlers
    this.pending = new Map(); // socket id -> frames that beat the handler registration
    this.listening = null;
  }

  async request(method, url, body, extraHeaders) {
    try {
      const res = await this.invoke('bisq_http', {
        method, url, body: body ?? null, headers: extraHeaders ?? null,
      });
      return { status: res.status, body: res.body };
    } catch (e) {
      throw asError(e);
    }
  }

  /** One 'bisq-ws' listener for every socket; frames carry their own id. */
  async _ensureListener() {
    if (!this.listening) {
      this.listening = this.listen('bisq-ws', (event) => this._route(event?.payload));
    }
    await this.listening;
  }

  _route(frame) {
    if (!frame || typeof frame.id !== 'number') return;
    const handlers = this.handlers.get(frame.id);
    if (handlers) {
      this._dispatch(frame.id, handlers, frame);
      return;
    }
    // The shell resolves bisq_ws_open only after the handshake, so a frame can
    // in principle land in the gap before the id gets back here. Hold it.
    const queued = this.pending.get(frame.id) ?? [];
    queued.push(frame);
    this.pending.set(frame.id, queued);
  }

  _dispatch(id, handlers, { kind, data }) {
    if (kind === 'message') handlers.onMessage?.(data ?? '');
    else if (kind === 'error') handlers.onError?.(new Error(data ?? 'websocket error'));
    else if (kind === 'close') {
      this.handlers.delete(id);
      this.pending.delete(id);
      handlers.onClose?.();
    }
  }

  async openSocket(url, handlers = {}) {
    await this._ensureListener();

    let id;
    try {
      id = await this.invoke('bisq_ws_open', { url, headers: handlers.headers ?? null });
    } catch (e) {
      throw asError(e);
    }

    this.handlers.set(id, handlers);
    const queued = this.pending.get(id);
    if (queued) {
      this.pending.delete(id);
      for (const frame of queued) this._dispatch(id, handlers, frame);
    }

    return {
      send: (text) =>
        this.invoke('bisq_ws_send', { id, text }).catch((e) => handlers.onError?.(asError(e))),
      close: () => this.invoke('bisq_ws_close', { id }).catch(() => {}),
    };
  }
}

/** The Tauri v2 globals, or null in a plain browser. Needs withGlobalTauri. */
export function tauriApi(scope = globalThis) {
  const t = scope.__TAURI__;
  const invoke = t?.core?.invoke;
  const listen = t?.event?.listen;
  if (typeof invoke !== 'function' || typeof listen !== 'function') return null;
  return { invoke: invoke.bind(t.core), listen: listen.bind(t.event) };
}

/** IPC inside the desktop app, direct sockets in a browser. */
export function pickTransport(scope = globalThis) {
  const api = tauriApi(scope);
  return api ? new TauriTransport(api) : new WebTransport(scope);
}
