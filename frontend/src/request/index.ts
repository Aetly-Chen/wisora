import axios, { type AxiosInstance } from 'axios'
import { REQUEST_TIMEOUT } from './constant'
import type { RequestConfig } from './types'

/**
 * Wisora 统一请求实例
 *
 * 这里解决两个问题：
 *
 * 1. 支持：
 *    request(config)
 *
 * 2. 支持：
 *    request.get()
 *    request.post()
 *    request.put()
 *    request.patch()
 *    request.delete()
 *
 * 同时由于响应拦截器最终返回的是 raw.data，
 * 所以业务层：
 *
 * request.post<LoginResult>()
 *
 * 最终类型为：
 *
 * Promise<LoginResult>
 */
interface RequestInstance
  extends Omit<
    AxiosInstance,
    'get' | 'post' | 'put' | 'patch' | 'delete'
  > {
  /**
   * 支持：
   *
   * request(config)
   *
   * 主要用于：
   * - retry
   * - refresh 后重新请求
   */
  <T = unknown>(
    config: RequestConfig,
  ): Promise<T>

  /**
   * GET
   */
  get<T = unknown>(
    url: string,
    config?: RequestConfig,
  ): Promise<T>

  /**
   * POST
   */
  post<
    T = unknown,
    D = unknown,
  >(
    url: string,
    data?: D,
    config?: RequestConfig<D>,
  ): Promise<T>

  /**
   * PUT
   */
  put<
    T = unknown,
    D = unknown,
  >(
    url: string,
    data?: D,
    config?: RequestConfig<D>,
  ): Promise<T>

  /**
   * PATCH
   */
  patch<
    T = unknown,
    D = unknown,
  >(
    url: string,
    data?: D,
    config?: RequestConfig<D>,
  ): Promise<T>

  /**
   * DELETE
   */
  delete<T = unknown>(
    url: string,
    config?: RequestConfig,
  ): Promise<T>
}

/**
 * 创建 Axios 实例
 *
 * 注意：
 * 这里只负责创建实例。
 *
 * 不在这里挂载拦截器，
 * 避免 index.ts 和 interceptor.ts 产生循环依赖。
 */
const request = axios.create({
  baseURL: import.meta.env.VITE_BASE_API,
  timeout: REQUEST_TIMEOUT,
}) as RequestInstance

export default request

export type { RequestConfig }