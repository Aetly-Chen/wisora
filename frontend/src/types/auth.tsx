export type AuthMode = 'login' | 'register' | 'forgot'; // 认证面板当前展示哪个表单
export type LoginMethod = 'password' | 'code'; // 登录方式：密码 / 邮箱验证码
export type ViewDevice = 'auto' | 'desktop' | 'h5'; // 预览用的视口形态，auto 交给 CSS 断点

/**
 * 前端展示用的用户模型（`WorkspaceDashboard` 这类仪表盘组件消费它）。
 *
 * ⚠️ **注意它和后端 `/user/profile` 返回的 `AuthUser` 不是同一形状**：
 * 后端给的是 `id / email / nickname / handle / bio / createdAt`，
 * 这里的 `name / avatar / role / tokenBalance` 是早期仪表盘自己的字段。
 * 真要接后端数据时先核对，别直接互相赋值。
 */
export interface UserProfile {
  id: string; // 用户主键
  name: string; // 展示名（对应后端的 nickname，但字段名不同）
  email: string; // 邮箱
  avatar: string; // 头像地址；空串表示用首字母兜底
  role: string; // 角色标识，仪表盘上用来区分身份标签
  tokenBalance: number; // token 余额（展示用数字）
}

/**
 * 注册接口参数
 */
export interface RegisterParams {
  nickname: string; // 昵称，2-20 字符，后端会校验唯一性以外的规则
  email: string; // 邮箱，注册后不可改
  password: string; // 密码明文，后端哈希后存储
  confirmPassword: string; // 确认密码；必须与 password 一致（跨字段校验在 service 里做）
  emailCode: string; // 邮箱验证码，存在 Redis 的 verify-code:register:<email>
}
/**
 * 邮箱密码登录接口参数
 */
export interface LoginParams {
  email: string; // 登录邮箱
  password: string; // 登录密码明文
}
/**
 * 邮箱验证码登录接口参数
 */
export interface LoginByCodeParams {
  email: string; // 登录邮箱
  emailCode: string; // 邮箱验证码，存在 Redis 的 verify-code:login:<email>
}

/**
 * 获取验证码参数
 */
export interface SendCodeParams {
  email: string; // 验证码发往哪个邮箱
}
/**
 * 刷新 Token 参数
 */
export interface RefreshTokenResult {
  accessToken: string; // 新的访问令牌（默认 15 分钟）
  refreshToken?: string; // 新的刷新令牌；后端未轮换时为空，此时沿用旧值
}
/**
 * 忘记密码参数
 */
export interface ForgotPasswordParams {
  email: string; // 要重置密码的邮箱
  emailCode: string; // 该邮箱收到的验证码
  newPassword: string; // 新密码明文
  confirmPassword: string; // 确认新密码；必须与 newPassword 一致
}
