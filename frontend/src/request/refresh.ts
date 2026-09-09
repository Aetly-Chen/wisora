import type {
  AxiosError,
  AxiosRequestConfig,
} from 'axios'

/**
 * ========================================
 * Refresh Handler
 * ========================================
 *
 * 真正执行刷新 Token 的函数。
 *
 * 由业务层通过：
 *
 * setRefreshHandler()
 *
 * 注入。
 *
 * 例如：
 *
 * setupRefreshHandler(async () => {
 *   const result = await refreshToken()
 *
 *   return result.accessToken
 * })
 */
type RefreshHandler = () => Promise<
  string | null | void
>

/**
 * ========================================
 * Refresh Handler
 * ========================================
 *
 * 真正执行刷新 Token 的函数。
 */
let refreshHandler:
  | RefreshHandler
  | null = null

/**
 * ========================================
 * 是否正在刷新
 * ========================================
 */
let refreshing = false

/**
 * ========================================
 * 等待队列
 * ========================================
 *
 * 当多个请求同时收到 401：
 *
 * 请求 A
 *   ↓
 * 开始 refresh
 *
 * 请求 B
 *   ↓
 * 等待
 *
 * 请求 C
 *   ↓
 * 等待
 *
 * refresh 成功：
 *
 * A → 新 Token
 * B → 新 Token
 * C → 新 Token
 */
type QueueItem = {
  resolve: (
    token: string,
  ) => void

  reject: (
    error: unknown,
  ) => void
}

let queue: QueueItem[] = []

/**
 * ========================================
 * 注册 Refresh Handler
 * ========================================
 */
export function setRefreshHandler(
  handler: RefreshHandler,
) {
  refreshHandler = handler
}

/**
 * ========================================
 * 清空刷新队列
 * ========================================
 *
 * 刷新失败的时候使用。
 */
function rejectQueue(
  error: unknown,
) {
  queue.forEach(
    ({ reject }) => {
      reject(error)
    },
  )

  queue = []
}

/**
 * ========================================
 * Token 刷新队列
 * ========================================
 *
 * 工作流程：
 *
 *                    HTTP 401
 *                       │
 *                       ▼
 *              runRefreshQueue()
 *                       │
 *             ┌─────────┴─────────┐
 *             │                   │
 *       refreshing=false    refreshing=true
 *             │                   │
 *             ▼                   ▼
 *       开始刷新 Token          加入 queue
 *             │
 *       ┌─────┴─────┐
 *       │           │
 *      成功         失败
 *       │           │
 *       ▼           ▼
 *   通知 queue     拒绝 queue
 *       │
 *       ▼
 * 重新执行原请求
 */
export async function runRefreshQueue(
  error: AxiosError,
  retryRequest: (
    token?: string | null,
  ) => Promise<any>,
) {
  /**
   * ========================================
   * ① 必须是 HTTP 401
   * ========================================
   *
   * 你的后端约定：
   *
   * 401
   * ↓
   * AccessToken 过期 / 无效
   */
  if (
    error.response?.status !== 401
  ) {
    throw error
  }

  /**
   * 没有注册 refresh handler
   *
   * 无法刷新 Token
   */
  if (!refreshHandler) {
    throw error
  }

  /**
   * ========================================
   * ② 获取原始请求
   * ========================================
   */
  const originalConfig =
    error.config as
      | (
          AxiosRequestConfig & {
            _retry?: boolean
          }
        )
      | undefined

  if (!originalConfig) {
    throw error
  }

  /**
   * ========================================
   * ③ 防止无限刷新
   * ========================================
   *
   * 第一次：
   *
   * _retry === undefined
   *
   * ↓
   *
   * _retry = true
   *
   *
   * 如果新的 AccessToken
   * 仍然返回 401：
   *
   * _retry === true
   *
   * ↓
   *
   * 直接失败
   */
  if (originalConfig._retry) {
    throw error
  }

  originalConfig._retry = true

  /**
   * ========================================
   * ④ 已经有请求正在刷新
   * ========================================
   *
   * 当前请求进入等待队列。
   */
  if (refreshing) {
    return new Promise(
      (
        resolve,
        reject,
      ) => {
        queue.push({
          resolve: (
            token,
          ) => {
            retryRequest(token)
              .then(resolve)
              .catch(reject)
          },

          reject,
        })
      },
    )
  }

  /**
   * ========================================
   * ⑤ 当前请求负责刷新
   * ========================================
   */
  refreshing = true

  try {
    /**
     * 执行真正的刷新接口
     *
     * refreshHandler 通常会调用：
     *
     * POST /auth/refresh
     *
     * 返回：
     *
     * {
     *   accessToken: 'xxx'
     * }
     */
    const newToken =
      await refreshHandler()

    /**
     * ========================================
     * ⑥ RefreshToken 失效
     * ========================================
     *
     * refreshHandler 返回：
     *
     * null / undefined
     *
     * 代表刷新失败。
     */
    if (!newToken) {
      rejectQueue(error)

      throw error
    }

    /**
     * ========================================
     * ⑦ Refresh 成功
     * ========================================
     *
     * 通知所有正在等待的请求。
     */
    const pendingQueue =
      queue

    queue = []

    pendingQueue.forEach(
      ({
        resolve,
      }) => {
        resolve(newToken)
      },
    )

    /**
     * ========================================
     * ⑧ 当前第一个请求重新发送
     * ========================================
     *
     * interceptor.ts 中的 retryRequest
     * 会：
     *
     * 1. setToken(newToken)
     *
     * 2. request(originalConfig)
     */
    return retryRequest(
      newToken,
    )
  } catch (refreshError) {
    /**
     * ========================================
     * ⑨ Refresh 异常
     * ========================================
     *
     * 例如：
     *
     * /auth/refresh
     * ↓
     * 401
     *
     * 或：
     *
     * 网络错误
     */
    rejectQueue(
      refreshError,
    )

    throw refreshError
  } finally {
    /**
     * ========================================
     * ⑩ 恢复刷新状态
     * ========================================
     */
    refreshing = false
  }
}