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
  page: number; // 页码，从 1 开始
  pageSize: number; // 每页条数
}

export interface PageResult<T> {
  list: T[]; // 当前页数据
  total: number; // 符合条件总条数，用于算总页数
  page: number; // 回显的页码（后端可能纠正越界值）
  pageSize: number; // 回显的每页条数
}

// export interface LoginParams {
//   email: string;
//   password: string;
// }

/**
 * 用户公开信息。
 *
 * 登录响应里的 `user` 与 `GET /user/profile` 返回的是**同一个形状** ——
 * 两端都由后端 `common/user-shape.ts` 的 USER_PUBLIC_SELECT 决定，
 * 所以这里只需要一份类型。之前这里是按登录响应写的，字段比 profile
 * 少三个，前端只能靠 `as` 糊过去。
 */
export interface AuthUser {
  id: string; // 用户主键
  email: string; // 邮箱，唯一且不可改
  nickname: string | null; // 昵称；注册后可能还没填
  /** 账号标识，老数据可能为空 */
  handle: string | null;
  /** 个性签名 */
  bio: string | null;
  /** 注册时间（后端 Date 经 JSON 序列化后的 ISO 字符串） */
  createdAt: string;
}

export interface LoginResult {
  accessToken: string; // 访问令牌，放 Authorization: Bearer 里，默认 15 分钟
  refreshToken: string; // 刷新令牌，access 过期时用它换新的
  user: AuthUser; // 登录用户信息（与 /user/profile 同形状）
}

/**
 * ⚠️ 遗留形状：`{ id, name, email, avatar }` 与后端实际返回的 `AuthUser` 不一致。
 * 新代码请用 `AuthUser`；这里保留是因为还有组件按旧字段取值。
 */
export interface UserProfile {
  id: string; // 用户主键
  name: string; // 展示名（后端字段是 nickname）
  email: string; // 邮箱
  avatar?: string; // 头像地址；缺省时用首字母兜底
}

export interface UploadResult {
  url: string; // 可访问的文件地址（早期通用上传接口返回的直链）
  fileName: string; // 服务端保存的文件名
  size: number; // 字节数
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
  id: string; // 用户主键
  email: string; // 邮箱（`/auth/test-token` 用来验证令牌是否仍然有效）
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
