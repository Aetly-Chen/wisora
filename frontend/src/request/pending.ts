import type { RequestConfig } from './types'

const pendingMap = new Map<string, AbortController>()

export function generateRequestKey(config: RequestConfig) {
  const {
    method = '',
    url = '',
    params = {},
    data = {},
  } = config

  return [
    method,
    url,
    JSON.stringify(params),
    JSON.stringify(data),
  ].join('&')
}

/**
 * 添加请求
 *
 * 如果存在相同请求：
 * 取消旧请求
 * 然后保存新请求
 */
export function addPending(config: RequestConfig) {
  if (!config.cancelRepeat) return

  const key = generateRequestKey(config)

  // 只取消“旧请求”
  const oldController = pendingMap.get(key)

  if (oldController) {
    oldController.abort()
    pendingMap.delete(key)
  }

  const controller = new AbortController()

  config.signal = controller.signal

  pendingMap.set(key, controller)

  config.metadata = {
    ...(config.metadata ?? {
      startTime: Date.now(),
      requestId: key,
    }),
    abortController: controller,
  }
}

/**
 * 请求已经结束
 *
 * 这里只负责从 pendingMap 删除
 * ❗不能 abort
 */
export function removePending(config: RequestConfig) {
  if (!config.cancelRepeat) return

  const key = generateRequestKey(config)

  const controller = pendingMap.get(key)

  // 只删除当前请求自己的 controller
  if (controller === config.metadata?.abortController) {
    pendingMap.delete(key)
  }
}

/**
 * 清除全部请求
 *
 * 例如：
 * - 退出登录
 * - 页面销毁
 */
export function clearPending() {
  pendingMap.forEach((controller) => {
    controller.abort()
  })

  pendingMap.clear()
}