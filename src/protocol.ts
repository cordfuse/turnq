export interface ChannelMeta {
  leaseMs: number;
  maxDepth?: number;
  maxWaitMs?: number;
}

export interface ChannelInfo extends ChannelMeta {
  name: string;
  depth: number;
  active: string | null;
}

export interface QueueEntryInfo {
  clientId: string;
  requestId: string;
  position: number;
  enqueuedAt: number;
  waitingMs: number;
}

export interface QueuedPayload {
  channel: string;
  requestId: string;
  position: number;
}

export interface YourTurnPayload {
  channel: string;
  requestId: string;
  leaseExpiresAt: number;
}

export interface PositionUpdatedPayload {
  channel: string;
  requestId: string;
  position: number;
}

export interface TimeoutPayload {
  channel: string;
  requestId: string;
  reason: 'lease_expired';
}

export interface TurnStartedPayload {
  channel: string;
  clientId: string;
}

export interface TurnCompletedPayload {
  channel: string;
  clientId: string;
  success: boolean;
  error?: string;
}

export interface StepStartedPayload {
  channel: string;
  clientId: string;
  step: string;
}

export interface StepEndedPayload {
  channel: string;
  clientId: string;
  step: string;
  success: boolean;
  error?: string;
}

export type EventType =
  | 'queued'
  | 'your-turn'
  | 'position-updated'
  | 'timeout'
  | 'turn-started'
  | 'turn-completed'
  | 'step-started'
  | 'step-ended';
