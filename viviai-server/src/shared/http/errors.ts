import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestId } from './security.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorEnvelope {
  data: null;
  message: string;
  requestId: string;
  error: { code: string };
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
      error: { code: normalized.code },
    } satisfies ErrorEnvelope);
  }
}

function normalizeError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
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
