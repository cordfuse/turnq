export type ErrorCode =
  | 'CHANNEL_NOT_FOUND'
  | 'CHANNEL_EXISTS'
  | 'CHANNEL_NOT_EMPTY'
  | 'NOT_YOUR_TURN'
  | 'ALREADY_QUEUED'
  | 'MAX_DEPTH_EXCEEDED'
  | 'LEASE_EXPIRED'
  | 'MALFORMED_REQUEST'
  | 'INTERNAL_ERROR';

export class TurnqError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'TurnqError';
  }
}
