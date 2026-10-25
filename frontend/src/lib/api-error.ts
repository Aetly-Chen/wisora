/**
 * 从一次请求失败里取出「能给人看」的文案。
 *
 * 后端信封是 `{ code, msg, data }`，真正的错误说明在 `response.data.msg`；
 * 而 axios 自己的 `error.message` 是 `Request failed with status code 500`
 * 这种**给开发者看的东西**。
 *
 * 之前的页面横幅直接用了 `err.message`，用户看到的就是那串英文 ——
 * 同一个错误，toast 里是「模拟后端 500」、横幅里是 `Request failed...`，两套文案。
 *
 * 顺序：后端 msg → 网络错误提示 → 兜底文案。
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as
    | {
        response?: { data?: { msg?: string } }
        message?: string
      }
    | undefined

  const fromServer = e?.response?.data?.msg
  if (typeof fromServer === 'string' && fromServer.trim()) return fromServer

  /**
   * 没拿到响应体 = 连不上后端（后端没起、跨域、断网）。
   * axios 这里给的是 `Network Error`，同样不算人话。
   */
  if (!e?.response) return '无法连接服务器，请确认后端已启动'

  return e?.message || fallback
}
