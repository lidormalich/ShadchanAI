// ═══════════════════════════════════════════════════════════
// ShadchanAI — Typed API errors
//
// Controllers / services throw these; the global error middleware
// maps them to HTTP status codes + response envelopes.
// ═══════════════════════════════════════════════════════════

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super('not_found', id ? `${resource} ${id} not found` : `${resource} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, 409, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'forbidden') {
    super('forbidden', message, 403);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'unauthorized') {
    super('unauthorized', message, 401);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string, details?: unknown) {
    super('business_rule', message, 422, details);
  }
}
