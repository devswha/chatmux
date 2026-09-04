import { WebSocket } from 'ws';

type SendData = Parameters<WebSocket['send']>[0];
type SendOptions = Parameters<WebSocket['send']>[1];
type SendCallback = (error?: Error) => void;

/** Gate the transport itself so the first revoked frame cannot reach a listener. */
export class AuthorizedWebSocket extends WebSocket {
  private authorizationCheck: (() => boolean) | undefined;

  setAuthorizationCheck(check: () => boolean): void {
    this.authorizationCheck = check;
  }

  isAuthorized(): boolean {
    return this.authorizationCheck?.() ?? false;
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'message' && !this.isAuthorized()) return false;
    return super.emit(event, ...args);
  }

  override send(data: SendData, callback?: SendCallback): void;
  override send(data: SendData, options: SendOptions, callback?: SendCallback): void;
  override send(data: SendData, options?: SendOptions | SendCallback, callback?: SendCallback): void {
    if (!this.isAuthorized()) {
      const done = typeof options === 'function' ? options : callback;
      if (done) queueMicrotask(() => done(new Error('WebSocket authorization is no longer valid.')));
      return;
    }
    if (typeof options === 'function' || options === undefined) super.send(data, options);
    else super.send(data, options, callback);
  }
}
