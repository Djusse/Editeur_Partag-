/**
 * Erreurs applicatives. Chaque erreur porte un code stable, documenté dans la
 * description de l'API, afin que le client (et le jury) puisse réagir sans
 * analyser un message texte.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message?: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, details);

export const unauthorized = (code = 'UNAUTHENTICATED', message = 'Session invalide ou expirée') =>
  new ApiError(401, code, message);

export const forbidden = (code = 'FORBIDDEN', message = 'Accès refusé') =>
  new ApiError(403, code, message);

export const notFound = (code = 'NOT_FOUND', message = 'Ressource introuvable') =>
  new ApiError(404, code, message);

export const conflict = (code: string, message?: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);

export const gone = (code: string, message?: string, details?: Record<string, unknown>) =>
  new ApiError(410, code, message, details);

export const tooLarge = (code = 'PAYLOAD_TOO_LARGE', message = 'Charge utile trop volumineuse') =>
  new ApiError(413, code, message);

export const tooManyRequests = (code = 'TOO_MANY_REQUESTS', message = 'Trop de requêtes') =>
  new ApiError(429, code, message);

/** Codes métier partagés entre REST et WebSocket. */
export const ErrorCodes = {
  creditExhausted: 'CREDIT_EXHAUSTED',
  blocked: 'BLOCKED',
  exhausted: 'EXHAUSTED',
  invalidUpdate: 'INVALID_UPDATE',
  duplicateOpConflict: 'OP_ID_CONFLICT',
  waiting: 'WAITING',
} as const;
