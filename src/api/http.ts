import {
  type CallHandler,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  type ArgumentsHost,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { BroadcastError } from '../broadcasts/broadcast.service.js';
import { AiDisabledError } from '../cx/cx.service.js';

/** Kobo amounts are bigint, which JSON cannot carry. They go out as text, and nothing else changes. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(jsonSafe));
  }
}

/** Turns broadcast and AI problems into the right HTTP status with a readable message. */
@Catch(BroadcastError, AiDisabledError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(err: BroadcastError | AiDisabledError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const statusCode = err instanceof BroadcastError ? err.status : 503;
    res.status(statusCode).json({ statusCode, message: err.message, error: statusCode === 503 ? 'Service Unavailable' : 'Error' });
  }
}
