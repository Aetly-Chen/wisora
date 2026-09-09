import type {
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios'

/**
 * 请求处理时会附加的内部元信息。
 *
 * 业务层一般不用直接碰这个字段，但它对：
 * - 记录开始时间
 * - 计算耗时
 * - 追踪重试次数
 * - 复用请求唯一标识
 * 很有用。
 */
export interface RequestMeta {
  startTime: number
  requestId: string
  cacheKey?: string
  loadingShown?: boolean
  retryCount?: number
  abortController?: AbortController
}

export interface RequestConfig<T = any>
  extends AxiosRequestConfig<T> {

  loading?: boolean

  /**
   * Token 刷新后的重试请求
   *
   * 重试请求不重新显示 Loading。
   */
  skipLoading?: boolean

  cache?: boolean
  cacheTime?: number
  retry?: number
  retryDelay?: number
  cancelRepeat?: boolean
  ignoreToken?: boolean
  ignoreError?: boolean
  ignoreResultCode?: boolean
  requestId?: string
  bypassRefresh?: boolean
  metadata?: RequestMeta
}

/**
 * 典型后端统一返回结构。
 *
 * 如果你的后端不是这种格式，可以把 interceptor
 * 里对 code/msg/data 的处理改掉。
 */
export interface ApiResult<T = any> {
  code: number
  msg: string
  data: T
}

/** 缓存中保存的结构，包含过期时间。 */
export interface CacheData<T = any> {
  expireAt: number
  data: T
}

/**
 * 目前保留给“手动取消某个任务”
 * 或“后续 UI 层管理任务”用。
 */
export interface PendingTask {
  controller: AbortController
  requestTime: number
  requestId: string
}

/** 供外部注册的全局错误/未授权处理器。 */
export interface RequestHandlers {
  onUnauthorized?: (
    error: unknown,
  ) => Promise<string | void> | string | void

  onGlobalError?: (
    error: unknown,
  ) => void
}

/**
 * 额外配置位。
 *
 * 这些字段不是 Axios 原生配置，
 * 而是业务层约定字段。
 */
export interface RequestExtraConfig {
  ignoreResultCode?: boolean
}

/** 带统一返回体的响应类型。 */
export interface RequestResponse<T = any>
  extends AxiosResponse<ApiResult<T>> {}