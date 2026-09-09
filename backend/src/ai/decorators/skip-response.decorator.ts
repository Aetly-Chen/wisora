import { SetMetadata } from '@nestjs/common';

export const SKIP_RESPONSE_KEY = 'skipResponse';

/**
 * 跳过全局 ResponseInterceptor 的响应包装。
 *
 * 用于 SSE / 文件下载 / 健康检查等需要原样透出响应体的场景。
 * 拦截器通过 Reflector 读取该元数据判断是否放行，
 * 而非判断 Content-Type（Nest 的 SSE 响应头在拦截器之后才写入）。
 */
export const SkipResponse = () => SetMetadata(SKIP_RESPONSE_KEY, true);
