export interface ApiResponse<T = any> {
  /**
   * 与 HTTP 状态码一致 —— 不是独立的业务码。
   *
   * 成功：200，POST 未写 `@HttpCode` 时是 201；失败：等于异常的状态码。
   * 前端因此要按 2xx 区间判成功，别再写 `code === 200`
   * （`frontend/src/request/constant.ts` 的 `isSuccessCode()`）。
   */
  code: number
  msg: string // 给人看的提示语；成功一般是 'ok'，失败是异常文案
  data: T // 业务载荷；失败响应里通常为 null
}