import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestId } from './security.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly safe?: {
      field?: string;
      details?: { reason?: string; limit?: number; retryAfterSeconds?: number };
    },
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorEnvelope {
  data: null;
  message: string;
  requestId: string;
  code: string;
  field?: string;
  details?: { reason?: string; limit?: number; retryAfterSeconds?: number };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const normalized = normalizeError(exception);
    response.status(normalized.status).json({
      data: null,
      message: normalized.message,
      requestId: getRequestId(request),
      code: normalized.code,
      ...(normalized.field ? { field: normalized.field } : {}),
      ...(normalized.details ? { details: normalized.details } : {}),
    } satisfies ErrorEnvelope);
  }
}

function normalizeError(error: unknown): {
  status: number;
  code: string;
  message: string;
  field?: string;
  details?: { reason?: string; limit?: number; retryAfterSeconds?: number };
} {
  if (error instanceof AppError) {
    const field =
      error.safe?.field && /^[a-zA-Z][a-zA-Z0-9.[\]_-]{0,119}$/.test(error.safe.field)
        ? error.safe.field
        : undefined;
    const raw = error.safe?.details;
    const details = raw
      ? {
          ...(typeof raw.reason === 'string' && /^[a-z_]{1,80}$/.test(raw.reason)
            ? { reason: raw.reason }
            : {}),
          ...(Number.isSafeInteger(raw.limit) && Number(raw.limit) >= 0
            ? { limit: raw.limit }
            : {}),
          ...(Number.isSafeInteger(raw.retryAfterSeconds) && Number(raw.retryAfterSeconds) >= 0
            ? { retryAfterSeconds: raw.retryAfterSeconds }
            : {}),
        }
      : undefined;
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(field ? { field } : {}),
      ...(details && Object.keys(details).length ? { details } : {}),
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: httpCode(status), message: error.message };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

function httpCode(status: number): string {
  const known: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
    [HttpStatus.UNAUTHORIZED]: 'AUTH_REQUIRED',
    [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
    [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
    [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
    [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
    [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  };
  return known[status] ?? 'HTTP_ERROR';
}
