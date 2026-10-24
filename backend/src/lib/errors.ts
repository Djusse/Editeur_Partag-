/**
 * Erreurs applicatives.
 *
 * L'interface exige des codes *texte* dans le champ `error` (`INVALID_INPUT`,
 * `FORBIDDEN`, …) : c'est donc ce format que renvoie le serveur, avec un code
 * HTTP cohérent.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { field?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.field = options.field;
    this.details = options.details;
  }
}

export const invalidInput = (field: string, message = 'Données invalides') =>
  new AppError(400, 'INVALID_INPUT', message, { field });

export const unauthorized = (message = 'Session invalide ou expirée') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Accès refusé') => new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Ressource introuvable') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const gone = (code: string, message: string) => new AppError(410, code, message);

export const tooLarge = (message = 'Charge utile trop volumineuse') =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', message);

export const unavailable = (code: string, message: string) => new AppError(503, code, message);

/** Codes utilisés par les messages WebSocket `error`. */
export const WsErrorCodes = {
  creditExhausted: 'CREDIT_EXHAUSTED',
  blocked: 'BLOCKED',
  forbidden: 'FORBIDDEN',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
} as const;
