/*
 * 必须放在所有 import 之前：环境变量是副作用式加载，而 TS 编译成 CJS 时
 * require 按源码顺序输出 —— 这一行会排在 require('./app.module') 之前，
 * 保证整张依赖图求值时 process.env 已就位。
 * 别挪进 prisma.service.ts 之类的地方，那会让「能否读到 env」取决于 import 顺序。
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  // 泛型指定平台类型才能用 useBodyParser 等 express 专有方法
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  /**
   * 请求体上限。
   *
   * Express 默认只有 100kb，而笔记正文是整篇 Markdown ——
   * 导入一份稍大的文档（>100KB）就会得到 500
   * 「request entity too large」，前端只能看到一个笼统的失败。
   * 这里放宽到 10mb，与前端导入的单文件上限留出余量。
   *
   * 用 Nest 自带的 useBodyParser，而不是 `import { json } from 'express'` ——
   * express 只是 @nestjs/platform-express 的传递依赖，
   * pnpm 的严格 node_modules 下应用代码解析不到它，
   * 那样写会在启动时报 Cannot find module 'express'。
   */
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });
  // ResponseInterceptor 依赖 Reflector 读取 @SkipResponse() 元数据（SSE 放行）
  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new ResponseInterceptor(reflector));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
