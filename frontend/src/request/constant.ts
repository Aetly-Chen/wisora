/**
 * 请求层的统一常量。
 *
 * 这些值尽量集中管理，避免散落在业务代码里。
 */
export const REQUEST_TIMEOUT=15000

/**
 * 判断响应信封里的 `code` 是否代表成功。
 *
 * 后端信封的 `code` 与 HTTP 状态码**对齐**，不是独立业务码：
 * GET 是 200，没写 `@HttpCode` 的 POST 是 201。所以只能按区间判，
 * 写死 `code === 200` 会把所有创建接口当成失败。
 */
export function isSuccessCode(code: number) {
  return code >= 200 && code < 300
}

export const TOKEN_EXPIRE_CODE=401

export const CACHE_PREFIX="REQUEST_CACHE"

export const RETRY_COUNT=3

export const RETRY_DELAY=1000
