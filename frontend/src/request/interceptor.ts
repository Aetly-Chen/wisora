import type {
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

import { AxiosHeaders } from "axios";

import request from "./index";

import { SUCCESS_CODE, RETRY_DELAY } from "./constant";

import { getToken, removeToken, removeRefreshToken, setToken } from "./storage";

import { addPending, clearPending, removePending } from "./pending";

import { showLoading, hideLoading } from "./loading";

import { notifyRequestError } from "./error";

import { logError, logRequest, logResponse } from "./logger";

import { getCache, setCache } from "./cache";

import { runRefreshQueue, setRefreshHandler } from "./refresh";

import type { ApiResult, RequestConfig } from "./types";

/**
 * ========================================
 * sleep
 * ========================================
 */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ========================================
 * 获取错误信息
 * ========================================
 */
function getErrorMessage(error: AxiosError<ApiResult>) {
  return error.response?.data?.msg || error.message || "网络请求失败";
}

/**
 * ========================================
 * 设置 Authorization
 * ========================================
 *
 * 统一处理 AxiosHeaders 类型问题。
 *
 * Axios 4.x 中：
 *
 * config.headers
 *
 * 不一定是普通对象，
 * 可能是 AxiosHeaders。
 *
 * 所以不要直接：
 *
 * config.headers.Authorization = xxx
 */
function setAuthorization(config: RequestConfig, token: string) {
  if (!config.headers) {
    config.headers = new AxiosHeaders();
  }

  if (config.headers instanceof AxiosHeaders) {
    config.headers.set("Authorization", `Bearer ${token}`);

    return;
  }

  config.headers = {
    ...config.headers,
    Authorization: `Bearer ${token}`,
  };
}

/**
 * ========================================
 * 请求拦截器
 * ========================================
 *
 * 负责：
 *
 * 1. 请求元信息
 * 2. AccessToken 注入
 * 3. Loading
 * 4. Cache
 * 5. Pending
 */
request.interceptors.request.use(
  (config: InternalAxiosRequestConfig & RequestConfig) => {
    /**
     * ========================================
     * 请求元信息
     * ========================================
     *
     * 非常重要：
     *
     * 这里必须保留 loadingShown。
     *
     * 因为：
     *
     * 第一次请求：
     *
     * loadingShown = false
     * ↓
     * showLoading()
     * ↓
     * loadingShown = true
     *
     * 如果 401：
     *
     * retry
     * ↓
     * 不能再次 showLoading()
     */
    config.metadata = {
      startTime: config.metadata?.startTime ?? Date.now(),

      requestId:
        config.requestId ??
        config.metadata?.requestId ??
        `${config.method ?? "get"}:${config.url ?? ""}:${Date.now()}`,

      retryCount: config.metadata?.retryCount ?? 0,

      cacheKey: config.metadata?.cacheKey,

      loadingShown: config.metadata?.loadingShown ?? false,

      abortController: config.metadata?.abortController,
    };

    /**
     * ========================================
     * Cache Key
     * ========================================
     */
    const cacheKey = config.cache
      ? (config.requestId ?? `${config.method ?? "get"}:${config.url ?? ""}`)
      : undefined;

    config.metadata.cacheKey = cacheKey;

    /**
     * ========================================
     * Loading
     * ========================================
     *
     * 关键修改：
     *
     * 只有第一次真正发送请求时
     * 才 showLoading。
     *
     * 401 retry 时：
     *
     * loadingShown === true
     *
     * 不再 showLoading。
     */
    if (config.loading && !config.metadata.loadingShown) {
      showLoading();

      config.metadata.loadingShown = true;
    }

    /**
     * ========================================
     * Cache
     * ========================================
     */
    if (config.cache && cacheKey) {
      const cached = getCache<unknown>(cacheKey);

      if (cached !== null) {
        /**
         * 命中缓存：
         *
         * 不再真正发送 HTTP 请求。
         */
        config.adapter = async () =>
          ({
            data: cached,
            status: 200,
            statusText: "OK",
            headers: {},
            config,
          }) as any;
      }
    }

    /**
     * ========================================
     * AccessToken
     * ========================================
     *
     * refresh / login / register
     * 可以通过：
     *
     * ignoreToken: true
     *
     * 跳过 Token 注入。
     */
    if (!config.ignoreToken) {
      const token = getToken();

      console.log("[请求拦截器]", config.url, "token =", token);

      if (token) {
        setAuthorization(config, token);
      }

      console.log(
        "[请求拦截器]",
        config.url,
        "Authorization =",
        config.headers
          ? config.headers instanceof AxiosHeaders
            ? config.headers.get("Authorization")
            : config.headers["Authorization"]
          : undefined,
      );
    }

    /**
     * ========================================
     * 日志
     * ========================================
     */
    logRequest(config);

    /**
     * ========================================
     * Pending
     * ========================================
     */
    addPending(config);

    return config as InternalAxiosRequestConfig;
  },

  /**
   * ========================================
   * 请求拦截器错误
   * ========================================
   */
  (error) => {
    hideLoading();

    logError(error);

    return Promise.reject(error);
  },
);

/**
 * ========================================
 * 响应拦截器
 * ========================================
 *
 * 成功：
 *
 * AxiosResponse
 *      ↓
 * response.data
 *      ↓
 * ApiResult
 *      ↓
 * raw.data
 *
 * 最终业务层拿到：
 *
 * LoginResult
 *
 * 而不是：
 *
 * AxiosResponse<LoginResult>
 */
request.interceptors.response.use(
  /**
   * ========================================
   * HTTP 请求成功
   * ========================================
   */
  async (response: AxiosResponse<ApiResult>) => {
    const config = response.config as RequestConfig;

    /**
     * ========================================
     * 请求收尾
     * ========================================
     */
    removePending(config);

    /**
     * ========================================
     * Loading
     * ========================================
     *
     * 这里统一结束 Loading。
     *
     * 包括：
     *
     * 普通请求：
     *
     * show
     * ↓
     * 200
     * ↓
     * hide
     *
     * 401：
     *
     * show
     * ↓
     * 401
     * ↓
     * refresh
     * ↓
     * retry
     * ↓
     * 200
     * ↓
     * hide
     *
     * 中间不会再次 show。
     */
    if (config.loading && config.metadata?.loadingShown) {
      hideLoading();

      config.metadata.loadingShown = false;
    }

    /**
     * ========================================
     * 请求耗时
     * ========================================
     */
    const end = Date.now();

    const start = config.metadata?.startTime ?? end;

    logResponse(response, end - start);

    /**
     * ========================================
     * 原始业务结果
     * ========================================
     */
    const raw = response.data;

    /**
     * ========================================
     * Cache
     * ========================================
     */
    if (config.cache && config.metadata?.cacheKey) {
      setCache(config.metadata.cacheKey, raw, config.cacheTime);
    }

    /**
     * ========================================
     * 忽略业务 code
     * ========================================
     */
    if (config.ignoreResultCode) {
      return raw;
    }

    /**
     * ========================================
     * 业务成功
     * ========================================
     */
    if (raw.code === SUCCESS_CODE) {
      return raw.data;
    }

    /**
     * ========================================
     * 普通业务错误
     * ========================================
     */
    if (!config.ignoreError) {
      notifyRequestError(raw.msg || "请求失败");

      return Promise.reject(raw);
    }

    return raw;
  },

  /**
   * ========================================
   * HTTP 请求失败
   * ========================================
   */
  async (error: AxiosError<ApiResult>) => {
    const config = error.config as RequestConfig | undefined;

    /**
     * ========================================
     * 请求收尾
     * ========================================
     */
    if (config) {
      removePending(config);

      /**
       * ========================================
       * Loading
       * ========================================
       *
       * 这里是解决遮罩闪烁的关键。
       *
       * 如果是：
       *
       * 401 + 需要刷新
       *
       * 不 hide。
       *
       * 保持遮罩：
       *
       * 原请求
       * ↓
       * 401
       * ↓
       * refresh
       * ↓
       * retry
       * ↓
       * 200
       * ↓
       * hide
       */
      const shouldRefresh =
        error.response?.status === 401 && !config.bypassRefresh;

      if (config.loading && !shouldRefresh && config.metadata?.loadingShown) {
        hideLoading();

        config.metadata.loadingShown = false;
      }
    }

    logError(error);

    /**
     * ========================================
     * 没有 config
     * ========================================
     */
    if (!config) {
      notifyRequestError(getErrorMessage(error));

      return Promise.reject(error);
    }

    /**
     * ========================================
     * ① AccessToken 过期
     * ========================================
     *
     * HTTP 401
     * ↓
     * refresh
     * ↓
     * retry
     */
    if (error.response?.status === 401 && !config.bypassRefresh) {
      /**
       * ========================================
       * retryRequest
       * ========================================
       */
      const retryRequest = async (nextToken?: string | null) => {
        if (nextToken) {
          /**
           * 保存新 Token
           */
          setToken(nextToken);

          /**
           * ========================================
           * 更新原请求 Authorization
           * ========================================
           *
           * 这里不要直接：
           *
           * config.headers.Authorization
           *
           * 因为 Axios 类型可能是：
           *
           * AxiosHeaders
           *
           * 或普通对象。
           */
          setAuthorization(config, nextToken);
        }

        console.log(
          "retry Authorization:",
          config.headers instanceof AxiosHeaders
            ? config.headers.get("Authorization")
            : config.headers?.Authorization,
        );

        /**
         * ========================================
         * 重新请求
         * ========================================
         *
         * 非常重要：
         *
         * 这里仍然保留：
         *
         * config.loading = true
         *
         * 但是请求拦截器会发现：
         *
         * metadata.loadingShown === true
         *
         * 所以不会再次 showLoading。
         */
        return request(config);
      };

      return runRefreshQueue(error, retryRequest);
    }

    /**
     * ========================================
     * ② 普通请求 Retry
     * ========================================
     */
    const retryCount = config.retry ?? 0;

    const currentRetry = config.metadata?.retryCount ?? 0;

    const canRetry = currentRetry < retryCount;

    if (canRetry) {
      config.metadata = {
        ...(config.metadata ?? {
          startTime: Date.now(),

          requestId: config.requestId ?? "",
        }),

        retryCount: currentRetry + 1,
      };

      await sleep(config.retryDelay ?? RETRY_DELAY);

      return request(config);
    }

    /**
     * ========================================
     * ③ 普通错误
     * ========================================
     */
    if (!config.ignoreError) {
      notifyRequestError(getErrorMessage(error));

      return Promise.reject(error);
    }

    return Promise.reject(error);
  },
);

/**
 * ========================================
 * 注册 Token 刷新处理器
 * ========================================
 *
 * 业务层：
 *
 * setupRefreshHandler(
 *   refreshAccessToken
 * )
 */
export function setupRefreshHandler(
  handler: () => Promise<string | null | void>,
) {
  setRefreshHandler(handler);
}

/**
 * ========================================
 * 退出登录
 * ========================================
 */
export function logoutRequestState() {
  clearPending();

  removeToken();

  removeRefreshToken();
}
