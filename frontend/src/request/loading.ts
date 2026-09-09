type LoadingListener = (count: number) => void

let loadingCount = 0
const listeners = new Set<LoadingListener>()

/**
 * 订阅 loading 状态变化。
 *
 * 这里没有直接绑定 UI，是为了让 request 层保持框架无关。
 * 未来你可以在任意组件里订阅这个状态，再渲染自己的全局 Loading。
 */
export function subscribeLoading(listener: LoadingListener) {
  listeners.add(listener)
  listener(loadingCount)

  return () => {
    listeners.delete(listener)
  }
}

/** 通知所有订阅者刷新 loading 计数。 */
function emit() {
  listeners.forEach((listener) => listener(loadingCount))
}

/** 请求开始时递增计数。 */
export function showLoading() {
  loadingCount += 1
  emit()
}

/** 请求结束时递减计数。 */
export function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1)
  emit()
}

/** 读取当前 loading 计数。 */
export function getLoadingCount() {
  return loadingCount
}
