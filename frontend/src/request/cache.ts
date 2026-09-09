import { CACHE_PREFIX } from './constant'
import type { CacheData } from './types'

const cacheMap = new Map<string, CacheData>()

/**
 * 统一生成 localStorage key。
 *
 * 这样做可以避免和项目里别的缓存项撞名。
 */
function makeKey(key: string) {
  return `${CACHE_PREFIX}:${key}`
}

/**
 * 读取缓存。
 *
 * 先读内存 Map，再回退到 localStorage。
 * 如果缓存过期，会自动删掉。
 */
export function getCache<T = any>(key: string): T | null {
  const raw = cacheMap.get(key) ?? readStorage(key)
  if (!raw) return null

  if (raw.expireAt < Date.now()) {
    removeCache(key)
    return null
  }

  return raw.data as T
}

/**
 * 写入缓存。
 *
 * ttl 默认 5 分钟，适合列表页、用户信息这种短期复用的数据。
 */
export function setCache<T = any>(key: string, data: T, ttl = 5 * 60 * 1000) {
  const payload: CacheData<T> = {
    expireAt: Date.now() + ttl,
    data,
  }

  cacheMap.set(key, payload)

  try {
    localStorage.setItem(makeKey(key), JSON.stringify(payload))
  } catch {
    // ignore storage errors
  }
}

/** 删除单个缓存。 */
export function removeCache(key: string) {
  cacheMap.delete(key)

  try {
    localStorage.removeItem(makeKey(key))
  } catch {
    // ignore storage errors
  }
}

/** 清空内存缓存。 */
export function clearCache() {
  cacheMap.clear()
}

function readStorage<T = any>(key: string): CacheData<T> | null {
  try {
    const raw = localStorage.getItem(makeKey(key))
    return raw ? (JSON.parse(raw) as CacheData<T>) : null
  } catch {
    return null
  }
}
