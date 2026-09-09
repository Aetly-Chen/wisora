import type { AxiosResponse } from 'axios'
import type { RequestConfig } from './types'

/**
 * 开发环境请求日志。
 *
 * 目的不是“打印越多越好”，而是让你快速看到：
 * - 发了什么请求
 * - 请求有没有带上关键参数
 * - 响应花了多长时间
 */
export function logRequest(config: RequestConfig) {
  if (import.meta.env.PROD) return

  console.groupCollapsed(
    `%c ${String(config.method ?? 'GET').toUpperCase()} ${config.url ?? ''}`,
    'color:#409eff',
  )
  console.log('Request', config)
}

/** 开发环境响应日志。 */
export function logResponse(response: AxiosResponse, time: number) {
  if (import.meta.env.PROD) return

  console.log('Response', response)
  console.log('Time', `${time}ms`)
  console.groupEnd()
}

/** 开发环境错误日志。 */
export function logError(error: unknown) {
  if (import.meta.env.PROD) return

  console.error('Request Error', error)
  console.groupEnd?.()
}
