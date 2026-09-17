import request from "./index";
import type { RequestConfig } from "./types";
import type {
  RegisterParams,
  LoginByCodeParams,
  SendCodeParams,
  LoginParams,
  RefreshTokenResult,
  ForgotPasswordParams,
} from "../types/auth";
import { getRefreshToken } from "./storage";

/**
 * 这里放的是“业务接口示例层”。
 *
 * 这一层的目标不是封装得最复杂，而是给你一个统一写法：
 * - 页面只关心调用哪个函数
 * - 函数内部统一通过 request 发请求
 * - 需要的配置直接在这里写清楚
 */

export interface PageParams {
  page: number;
  pageSize: number;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

// export interface LoginParams {
//   email: string;
//   password: string;
// }

/** 登录 / 注册响应里携带的用户信息（与后端 generateTokens 的返回对应） */
export interface AuthUser {
  id: string;
  email: string;
  nickname: string | null;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

export interface UploadResult {
  url: string;
  fileName: string;
  size: number;
}

/**
 * 注册接口
 * - 不需要 Token
 * - 发起时显示 Loading
 * - 重复点击时取消旧请求
 */
export function register(data: RegisterParams) {
  const config: RequestConfig = {
    ignoreToken: true,
    loading: true,
    cancelRepeat: true,
  };

  return request.post("/auth/register", data, config);
}
/**
 * 邮箱密码登录接口
 * - 不需要 Token
 * - 发起时显示 Loading
 * - 重复点击时取消旧请求
 */
export function login(data: LoginParams) {
  const config: RequestConfig = {
    ignoreToken: true,
    loading: true,
    cancelRepeat: true,
  };

  return request.post<LoginResult>("/auth/login", data, config);
}
/**
 * 邮箱验证码登录接口
 * - 不需要 Token
 * - 发起时显示 Loading
 * - 重复点击时取消旧请求
 */
export function loginByCode(data: LoginByCodeParams) {
  const config: RequestConfig = {
    ignoreToken: true,
    loading: true,
    cancelRepeat: true,
  };

  return request.post<LoginResult>("/auth/login-code", data, config);
}

/**
 * 获取当前登录用户资料。
 *
 * 用途：页面刷新后令牌仍在、但内存里的昵称已丢失，
 * 用它回查一次真实昵称；也兼容本次改动之前登录、
 * 本地仍存着默认值的老会话。
 */
export function getUserProfile(settings?: RequestConfig) {
  return request.get<AuthUser>("/user/profile", {
    loading: false,
    ...settings,
  });
}

/**
 * 注册获取邮箱验证码接口
 * - 不需要 Token
 * - 发起时显示 Loading
 * - 重复点击时取消旧请求
 */
export function sendRegisterCode(data: SendCodeParams) {
  const config: RequestConfig = {
    ignoreToken: true,
    loading: true,
    cancelRepeat: true,
  };

  return request.post("/auth/send-register-code", data, config);
}
/**
 * 登录获取邮箱验证码接口
 * - 不需要 Token
 * - 发起时显示 Loading
 * - 重复点击时取消旧请求
 */
export function sendLoginCode(data: SendCodeParams) {
  const config: RequestConfig = {
    ignoreToken: true,
    loading: true,
    cancelRepeat: true,
  };

  return request.post("/auth/send-login-code", data, config);
}
/**
 * 刷新 AccessToken
 *
 * 注意：
 * 1. 不携带 AccessToken
 * 2. bypassRefresh: true
 *
 * 防止 RefreshToken 失效以后：
 *
 * /auth/refresh
 *      ↓
 * 401
 *      ↓
 * 再次 refresh
 *      ↓
 * 无限循环
 */
export function refreshToken() {
  const refreshToken = getRefreshToken();

  const config: RequestConfig = {
    ignoreToken: true,
    bypassRefresh: true,
    cancelRepeat: true,
  };

  return request.post<RefreshTokenResult>(
    "/auth/refresh",
    {
      refreshToken,
    },
    config,
  );
}
export interface ProfileResult {
  id: string;
  email: string;
}

export function testToken() {
  const config: RequestConfig = {
    loading: false,
    cancelRepeat: false,
  };

  return request.get("/auth/test-token", config);
}
export const sendForgotPasswordCode = (email: string) => {
  return request.post(
    "/auth/send-forgot-password-code",
    {
      email,
    },
    {
      ignoreToken: true,
      loading: true,
      cancelRepeat: true,
    },
  );
};

export const forgotPassword = (data: ForgotPasswordParams) => {
  return request.post("/auth/forgot-password", data, {
    ignoreToken: true,
    loading: true,
    cancelRepeat: true,
  });
};
