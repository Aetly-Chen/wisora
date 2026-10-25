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
  startTime: number // 请求发出时的时间戳（毫秒），用来算耗时
  requestId: string // 本次请求的唯一标识；重试时沿用同一个，便于串日志
  cacheKey?: string // 命中缓存时的键（method + url + params 拼出来的）
  loadingShown?: boolean // 全局遮罩是否已由本次请求打开；重试时据此避免重复 show
  retryCount?: number // 已重试次数，与 config.retry 比较决定还能不能重试
  abortController?: AbortController // 用于取消请求（重复请求合并、离开页面时中断）
}

export interface RequestConfig<T = any>
  extends AxiosRequestConfig<T> {

  loading?: boolean // 是否显示全局 Loading 遮罩（默认 false，避免一个请求就盖住整页）

  /**
   * Token 刷新后的重试请求
   *
   * 重试请求不重新显示 Loading。
   */
  skipLoading?: boolean

  cache?: boolean // 是否启用 GET 缓存（只对 GET 生效）
  cacheTime?: number // 缓存有效期（毫秒）
  retry?: number // 失败重试次数上限（网络错误/5xx；401 走刷新流程不算这里）
  retryDelay?: number // 每次重试前的等待时间（毫秒）
  cancelRepeat?: boolean // 是否取消「同 method + 同 url + 同参数」的重复请求
  ignoreToken?: boolean // 是否跳过 Authorization 注入（登录、注册这类公开接口用）
  ignoreError?: boolean // 是否不上报全局错误提示（页面自己展示错误时用它，避免一处错误弹两次）
  ignoreResultCode?: boolean // 是否跳过信封解包与 code 判定，直接拿到原始响应体
  requestId?: string // 外部指定请求 id；不传则自动生成
  bypassRefresh?: boolean // 401 时是否跳过刷新流程，直接失败
  metadata?: RequestMeta // 内部元信息，由拦截器写入
}

/**
 * 典型后端统一返回结构。
 *
 * 如果你的后端不是这种格式，可以把 interceptor
 * 里对 code/msg/data 的处理改掉。
 */
export interface ApiResult<T = any> {
  code: number // 与 HTTP 状态码一致（GET 200 / 未写 @HttpCode 的 POST 201）；判成功用 2xx
  msg: string // 给人看的提示文案；失败时前端直接展示它
  data: T // 业务数据；失败时通常为 null
}

/** 缓存中保存的结构，包含过期时间。 */
export interface CacheData<T = any> {
  expireAt: number // 过期时间戳（毫秒），读缓存时与 Date.now() 比较
  data: T // 缓存下来的数据（信封里的 data）
}

/**
 * 目前保留给“手动取消某个任务”
 * 或“后续 UI 层管理任务”用。
 */
export interface PendingTask {
  controller: AbortController // 取消这条请求用的控制器
  requestTime: number // 发起时间戳，用于判断是否超时
  requestId: string // 与 metadata.requestId 对应，便于按 id 找到并取消
}

/** 供外部注册的全局错误/未授权处理器。 */
export interface RequestHandlers {
  onUnauthorized?: (
    error: unknown,
  ) => Promise<string | void> | string | void // 收到 401 时的回调；返回新 token 则重试原请求
  // ⚠️ 目前没有任何地方注册 onUnauthorized / onGlobalError（零引用死代码），
  //    401 的实际处理在 refresh.ts 的 runRefreshQueue 里

  onGlobalError?: (
    error: unknown,
  ) => void // 全局错误回调；同样未被使用
}

/**
 * 额外配置位。
 *
 * 这些字段不是 Axios 原生配置，
 * 而是业务层约定字段。
 */
export interface RequestExtraConfig {
  ignoreResultCode?: boolean // 跳过信封解包，直接返回原始响应（流式接口、下载二进制时用）
}

/** 带统一返回体的响应类型。 */
export interface RequestResponse<T = any>
  extends AxiosResponse<ApiResult<T>> {}
