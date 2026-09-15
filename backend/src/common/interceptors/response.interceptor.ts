import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_RESPONSE_KEY } from '../decorators/skip-response.decorator';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // SSE / 文件下载 / 健康检查等场景（@SkipResponse()）原样透出，
    // 用元数据判断而非 Content-Type：Nest 的 SSE 响应头在拦截器之后才写入
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    return next.handle().pipe(
      map((data: unknown) => ({
        code: 200,
        msg: 'ok',
        data,
      })),
    );
  }
}
