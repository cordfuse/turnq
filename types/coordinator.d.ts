export interface CoordinatorOptions {
  url?: string;
  apiKey?: string;
  fallback?: boolean;
}

export interface Coordinator {
  createChannel(name: string, opts?: { leaseMs?: number }): Promise<void>;
  withTurn<T>(channel: string, fn: () => Promise<T>): Promise<T>;
  close(): void;
}

export declare function createCoordinator(opts?: CoordinatorOptions): Promise<Coordinator>;
