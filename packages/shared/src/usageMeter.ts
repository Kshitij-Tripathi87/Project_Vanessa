export type UsageKind =
  | "stt_audio_seconds"
  | "tts_characters"
  | "llm_input_tokens"
  | "llm_output_tokens";

export interface UsageReservation {
  id: string;
  requestId: string;
  userId: string;
  model: string;
  kind: UsageKind;
  reservedCostInr: number;
  createdAt: number;
}

export interface UsageEvent {
  id: string;
  requestId: string;
  userId: string;
  model: string;
  kind: UsageKind;
  quantity: number;
  estimatedCostInr: number;
  actualCostInr: number;
  status: "reserved" | "settled" | "failed" | "released";
  createdAt: number;
  settledAt?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageBudgetSnapshot {
  capInr: number;
  perUserCapInr: number;
  spentInr: number;
  reservedInr: number;
  availableInr: number | null;
  users: Record<string, { spentInr: number; reservedInr: number; availableInr: number | null }>;
  events: UsageEvent[];
}

export interface UsageBudgetOptions {
  capInr?: number;
  perUserCapInr?: number;
  maxEvents?: number;
}

/**
 * Small in-process ledger used before a provider request starts.
 *
 * A cap of zero means "meter only"; a positive cap reserves estimated spend
 * before a billable request and reconciles the reservation afterwards.
 */
export class UsageBudget {
  private readonly capInr: number;
  private readonly perUserCapInr: number;
  private readonly maxEvents: number;
  private spentInr = 0;
  private reservedInr = 0;
  private readonly userSpent = new Map<string, number>();
  private readonly userReserved = new Map<string, number>();
  private readonly reservations = new Map<string, UsageReservation>();
  private readonly events: UsageEvent[] = [];

  constructor(options: UsageBudgetOptions = {}) {
    this.capInr = Math.max(0, Number(options.capInr || 0));
    this.perUserCapInr = Math.max(0, Number(options.perUserCapInr || 0));
    this.maxEvents = Math.max(10, Math.floor(options.maxEvents || 500));
  }

  reserve(input: {
    requestId: string;
    userId?: string;
    model: string;
    kind: UsageKind;
    estimatedCostInr: number;
    metadata?: Record<string, unknown>;
  }): UsageReservation {
    const estimatedCostInr = Math.max(0, Number(input.estimatedCostInr || 0));
    const userId = input.userId || "local";
    const userSpent = this.userSpent.get(userId) || 0;
    const userReserved = this.userReserved.get(userId) || 0;
    if (this.capInr > 0 && this.spentInr + this.reservedInr + estimatedCostInr > this.capInr + 1e-9) {
      throw new Error(`Usage budget exceeded for ${input.requestId}.`);
    }
    if (this.perUserCapInr > 0 && userSpent + userReserved + estimatedCostInr > this.perUserCapInr + 1e-9) {
      throw new Error(`Usage budget exceeded for user ${userId}.`);
    }

    const reservation: UsageReservation = {
      id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      requestId: input.requestId,
      userId,
      model: input.model,
      kind: input.kind,
      reservedCostInr: estimatedCostInr,
      createdAt: Date.now(),
    };
    this.reservations.set(reservation.id, reservation);
    this.reservedInr += estimatedCostInr;
    this.userReserved.set(userId, userReserved + estimatedCostInr);
    this.pushEvent({
      id: reservation.id,
      requestId: reservation.requestId,
      userId: reservation.userId,
      model: reservation.model,
      kind: reservation.kind,
      quantity: 0,
      estimatedCostInr,
      actualCostInr: 0,
      status: "reserved",
      createdAt: reservation.createdAt,
      metadata: input.metadata,
    });
    return reservation;
  }

  settle(
    reservation: UsageReservation,
    input: {
      quantity: number;
      actualCostInr?: number;
      metadata?: Record<string, unknown>;
    },
  ): UsageEvent {
    const current = this.reservations.get(reservation.id);
    if (!current) throw new Error(`Unknown usage reservation ${reservation.id}.`);
    const actualCostInr = Math.max(0, Number(input.actualCostInr ?? current.reservedCostInr));
    this.reservations.delete(reservation.id);
    this.reservedInr = Math.max(0, this.reservedInr - current.reservedCostInr);
    this.adjustUserReserved(current.userId, -current.reservedCostInr);
    this.spentInr += actualCostInr;
    this.userSpent.set(current.userId, (this.userSpent.get(current.userId) || 0) + actualCostInr);
    return this.updateEvent(reservation.id, {
      quantity: Math.max(0, Number(input.quantity || 0)),
      actualCostInr,
      status: "settled",
      settledAt: Date.now(),
      metadata: input.metadata,
    });
  }

  fail(reservation: UsageReservation, error: string, metadata?: Record<string, unknown>): UsageEvent {
    const current = this.reservations.get(reservation.id);
    if (!current) throw new Error(`Unknown usage reservation ${reservation.id}.`);
    this.reservations.delete(reservation.id);
    this.reservedInr = Math.max(0, this.reservedInr - current.reservedCostInr);
    this.adjustUserReserved(current.userId, -current.reservedCostInr);
    return this.updateEvent(reservation.id, {
      status: "failed",
      settledAt: Date.now(),
      error: error.slice(0, 300),
      metadata,
    });
  }

  release(reservation: UsageReservation, metadata?: Record<string, unknown>): UsageEvent {
    const current = this.reservations.get(reservation.id);
    if (!current) throw new Error(`Unknown usage reservation ${reservation.id}.`);
    this.reservations.delete(reservation.id);
    this.reservedInr = Math.max(0, this.reservedInr - current.reservedCostInr);
    this.adjustUserReserved(current.userId, -current.reservedCostInr);
    return this.updateEvent(reservation.id, {
      status: "released",
      settledAt: Date.now(),
      metadata,
    });
  }

  snapshot(): UsageBudgetSnapshot {
    return {
      capInr: this.capInr,
      perUserCapInr: this.perUserCapInr,
      spentInr: this.spentInr,
      reservedInr: this.reservedInr,
      availableInr: this.capInr > 0 ? Math.max(0, this.capInr - this.spentInr - this.reservedInr) : null,
      users: this.userSnapshot(),
      events: this.events.map((event) => ({ ...event, metadata: event.metadata ? { ...event.metadata } : undefined })),
    };
  }

  private adjustUserReserved(userId: string, amount: number): void {
    const next = Math.max(0, (this.userReserved.get(userId) || 0) + amount);
    if (next === 0) this.userReserved.delete(userId);
    else this.userReserved.set(userId, next);
  }

  private userSnapshot(): UsageBudgetSnapshot["users"] {
    const users = new Set([...this.userSpent.keys(), ...this.userReserved.keys()]);
    return Object.fromEntries([...users].map((userId) => {
      const spentInr = this.userSpent.get(userId) || 0;
      const reservedInr = this.userReserved.get(userId) || 0;
      return [userId, {
        spentInr,
        reservedInr,
        availableInr: this.perUserCapInr > 0 ? Math.max(0, this.perUserCapInr - spentInr - reservedInr) : null,
      }];
    }));
  }

  private pushEvent(event: UsageEvent): void {
    this.events.push(event);
    while (this.events.length > this.maxEvents) this.events.shift();
  }

  private updateEvent(id: string, patch: Partial<UsageEvent>): UsageEvent {
    const index = this.events.findIndex((event) => event.id === id);
    if (index === -1) throw new Error(`Usage event ${id} was not recorded.`);
    const next = { ...this.events[index], ...patch };
    this.events[index] = next;
    return next;
  }
}
