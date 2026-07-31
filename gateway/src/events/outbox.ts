/**
 * Event types for the webhook outbox.
 * Events are queued for future dispatch to Scentic core.
 */

export type EventType =
  | 'KIMAI_CONNECTION_HEALTH_CHANGED'
  | 'KIMAI_FIRM_INITIALIZED'
  | 'KIMAI_MAPPING_CREATED'
  | 'KIMAI_MAPPING_FAILED'
  | 'KIMAI_TIME_ENTRY_CREATED'
  | 'KIMAI_TIME_ENTRY_UPDATED'
  | 'KIMAI_TIME_ENTRY_DELETED'
  | 'KIMAI_TIME_ENTRY_EXPORT_READY'
  | 'KIMAI_SYNC_FAILED';

export interface OutboxEvent {
  eventId: string;
  eventType: EventType;
  scenticFirmId: string;
  correlationId: string;
  createdAt: string;
  payload: Record<string, unknown>;
  safeSummary: string; // no secrets, no confidential matter names
  retryCount: number;
  maxRetries: number;
  status: 'PENDING' | 'SENT' | 'FAILED';
}

export interface EventOutbox {
  publish(event: Omit<OutboxEvent, 'eventId' | 'createdAt' | 'retryCount' | 'maxRetries' | 'status'>): OutboxEvent;
  getPending(): OutboxEvent[];
  markSent(eventId: string): void;
  markFailed(eventId: string): void;
  clear(): void;
}

export class InMemoryEventOutbox implements EventOutbox {
  private events: OutboxEvent[] = [];

  publish(event: Omit<OutboxEvent, 'eventId' | 'createdAt' | 'retryCount' | 'maxRetries' | 'status'>): OutboxEvent {
    const fullEvent: OutboxEvent = {
      ...event,
      eventId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 5,
      status: 'PENDING',
    };
    this.events.push(fullEvent);
    return fullEvent;
  }

  getPending(): OutboxEvent[] {
    return this.events.filter(e => e.status === 'PENDING');
  }

  markSent(eventId: string): void {
    const event = this.events.find(e => e.eventId === eventId);
    if (event) event.status = 'SENT';
  }

  markFailed(eventId: string): void {
    const event = this.events.find(e => e.eventId === eventId);
    if (event) {
      event.retryCount++;
      if (event.retryCount >= event.maxRetries) {
        event.status = 'FAILED';
      }
    }
  }

  clear(): void {
    this.events = [];
  }

  getAll(): OutboxEvent[] {
    return [...this.events];
  }
}
