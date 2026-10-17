import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpStatus,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
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

    // 信封里的 code 与 HTTP 状态码保持一致（GET 200 / 未写 @HttpCode 的 POST 201）
    const code = this.resolveStatusCode(context);

    return next.handle().pipe(
      map((data: unknown) => ({
        code,
        msg: 'ok',
        data,
      })),
    );
  }

  /**
   * 复算 Nest 将要写进响应头的状态码。
   *
   * 拦截器执行时 Nest 还没 setStatus（它在 handler 返回后才写），所以不能读
   * `res.statusCode`，只能按同一套规则自己算一遍：
   * 显式 `@HttpCode(...)` → POST 默认 201 → 其余 200。
   * 见 @nestjs/core 的 RouterResponseController.getStatusByMethod。
   *
   * 改前这里写死 200，而 17 个 @Post 里有 14 个实际返回 201 —— body 说 code 200、
   * HTTP 说 201，两级状态码打架。前端只认 body 的 code，所以一直没暴露。
   */
  private resolveStatusCode(context: ExecutionContext): number {
    // 全局拦截器同样作用于 WebSocket 网关（chat.gateway），那里没有 HTTP 状态码
    if (context.getType() !== 'http') return HttpStatus.OK;

    const explicit = this.reflector.get<number>(
      HTTP_CODE_METADATA,
      context.getHandler(),
    );
    if (explicit !== undefined) return explicit;

    const request = context.switchToHttp().getRequest<{ method?: string }>();
    return request.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
  }
}
