export declare class LocalTurnqClient {
  constructor(lockDir?: string);
  createChannel(name: string, opts?: unknown): Promise<void>;
  withTurn<T = void>(channel: string, fn: () => Promise<T>): Promise<T>;
  close(): void;
}
