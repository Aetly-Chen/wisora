export type AuthMode = 'login' | 'register' | 'forgot';
export type LoginMethod = 'password' | 'code';
export type ViewDevice = 'auto' | 'desktop' | 'h5';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar: string;
  role: string;
  tokenBalance: number;
}

/**
 * 注册接口参数
 */
export interface RegisterParams {
  nickname: string;
  email: string;
  password: string;
  confirmPassword: string;
  emailCode: string;
}
/**
 * 邮箱密码登录接口参数
 */
export interface LoginParams {
  email: string;
  password: string;
}
/**
 * 邮箱验证码登录接口参数
 */
export interface LoginByCodeParams {
  email: string;
  emailCode: string;
}

/**
 * 获取验证码参数
 */
export interface SendCodeParams {
  email: string;
}
/**
 * 刷新 Token 参数
 */
export interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
}
/**
 * 忘记密码参数
 */
export interface ForgotPasswordParams {
  email: string;
  emailCode: string;
  newPassword: string;
  confirmPassword: string;
}
