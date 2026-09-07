import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { getRequestId } from './security.js';

export interface SuccessEnvelope<T> {
  data: T;
  message: 'ok';
  requestId: string;
}

@Injectable()
export class EnvelopeInterceptor<T> implements NestInterceptor<T, SuccessEnvelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<SuccessEnvelope<T>> {
    const request = context.switchToHttp().getRequest();
    return next
      .handle()
      .pipe(map((data) => ({ data, message: 'ok', requestId: getRequestId(request) })));
  }
}
