/*
 * 必须放在所有 import 之前：环境变量是副作用式加载，而 TS 编译成 CJS 时
 * require 按源码顺序输出 —— 这一行会排在 require('./app.module') 之前，
 * 保证整张依赖图求值时 process.env 已就位。
 * 别挪进 prisma.service.ts 之类的地方，那会让「能否读到 env」取决于 import 顺序。
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

const bootLogger = new Logger('Process');

/**
 * 「最后一道网」：接住没人处理的异步异常，**记录但不退出**。
 *
 * 背景：Node 15+ 的默认行为是「未处理的 Promise 拒绝 → 进程直接退出」。
 * 而 Redis 在这个项目里是**可选依赖**（挂了只该降级：限流失效、热缓存失效），
 * 但任何一处漏了 catch 的 `redis.xxx()` 都会让整个 API 陪葬。
 * 实测过一次：ioredis 重试次数耗尽后抛 `MaxRetriesPerRequestError`，进程退出 ——
 * `app.listen` 之后再没人能接住它。
 *
 * ⚠️ 这不是「吞错误」：日志里保留完整栈，定位照样能定位；
 * 区别只在于「一个请求的失败」不会变成「所有在线用户的连接一起断」。
 *
 * ⚠️ `uncaughtException` 保留进程是有争议的（状态可能已不一致）。
 * 这里选择继续服务，是因为本项目最可能的触发源是 Redis/网络这类
 * **不污染内存状态**的外部依赖异常；如果是内存/状态类 bug，日志会先暴露它。
 */
process.on('unhandledRejection', (reason) => {
  bootLogger.error(
    `未处理的 Promise 拒绝（进程继续运行）：${
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    }`,
  );
});

process.on('uncaughtException', (reason) => {
  bootLogger.error(
    `未捕获异常（进程继续运行）：${
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    }`,
  );
});

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
