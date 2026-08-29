import { FleetProtocolError } from './errors.js';

export interface FleetWritableTransport {
  send(payload: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}

type QueuedFrame = Readonly<{ readonly payload: string; readonly bytes: number }>;

export type FleetWriterOptions = Readonly<{
  readonly maxFrames?: number;
  readonly maxBytes?: number;
}>;

export class FleetBoundedWriter {
  private readonly queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private sending = false;
  private readonly maxFrames: number;
  private readonly maxBytes: number;

  constructor(private readonly transport: FleetWritableTransport, options: FleetWriterOptions = {}) {
    this.maxFrames = options.maxFrames ?? 256;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
  }

  send(payload: string): void {
    const bytes = Buffer.byteLength(payload);
    if (this.queue.length >= this.maxFrames || this.queuedBytes + bytes > this.maxBytes) {
      this.transport.close(4008, 'fleet writer capacity exceeded');
      throw new FleetProtocolError('PROTOCOL_QUEUE_FULL', 'fleet writer queue is full');
    }
    this.queue.push({ payload, bytes });
    this.queuedBytes += bytes;
    this.flush();
  }

  private flush(): void {
    if (this.sending) return;
    const frame = this.queue[0];
    if (frame === undefined) return;
    this.sending = true;
    this.transport.send(frame.payload, (error) => {
      this.sending = false;
      this.queue.shift();
      this.queuedBytes -= frame.bytes;
      if (error !== undefined) {
        this.transport.close(1011, 'fleet transport write failed');
        return;
      }
      this.flush();
    });
  }
}
