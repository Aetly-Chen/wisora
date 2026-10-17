import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { Request, Response } from 'express'

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()

    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let message = 'Internal Server Error'

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const res = exception.getResponse()

      if (typeof res === 'string') {
        message = res
      } else if (typeof res === 'object' && res !== null) {
        /*
         * 只认 Nest 的标准形状 `{ message }`（以及内置异常自带的 `error`）。
         *
         * 别在这里兼容 `{ code, msg }` 这种自定义对象 —— 传进来只会落到兜底
         * 'Internal Server Error'，文案静默丢失。要报给用户就用
         * BadRequestException / NotFoundException / HttpException(字符串, status)。
         */
        const body = res as Record<string, any>
        message = body.message || body.error || message
      }
    } else {
      /*
       * 非 HttpException = 未预期故障（数据库、第三方接口、代码 bug）。
       *
       * 改前这里把 exception.message 原样返回给客户端，于是 pg 的
       * "password authentication failed"、文件绝对路径、第三方接口的报错体
       * 都会跟着 500 出去。内部细节只进日志，对外一律固定文案。
       *
       * 想让用户看到原因，必须包成 HttpException 抛出来。
       */
      const request = ctx.getRequest<Request>()
      const where =
        typeof request?.method === 'string' &&
        typeof request?.originalUrl === 'string'
          ? `${request.method} ${request.originalUrl}`
          : '未知请求'
      const detail =
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception)

      this.logger.error(`未处理异常 ${where}`, detail)
    }

    response.status(status).json({
      code: status,
      msg: message,
      data: null,
    })
  }
}