type ErrorListener = (message: string | null) => void

let currentError: string | null = null
const listeners = new Set<ErrorListener>()

/**
 * 订阅全局错误消息。
 *
 * request 层只负责“发出错误信号”，
 * UI 层可以在任意地方订阅后统一弹窗展示。
 */
export function subscribeRequestError(listener: ErrorListener) {
  listeners.add(listener)
  listener(currentError)

  return () => {
    listeners.delete(listener)
  }
}

function emit() {
  listeners.forEach((listener) => listener(currentError))
}

/** 推送一条全局错误消息。 */
export function notifyRequestError(message: string) {
  currentError = message
  emit()
}

/** 清空当前错误消息。 */
export function clearRequestError() {
  currentError = null
  emit()
}
