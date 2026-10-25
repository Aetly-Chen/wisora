/**
 * 用户对外的公开形状 —— 唯一来源。
 *
 * 为什么单独抽出来：同一个 user 会由两个接口返回（登录响应里的 `user`，
 * 以及 `GET /user/profile`），而它们之前是各写一份字段列表。
 * 这种「同一实体两处各写一遍」正是最容易漏字段的地方 ——
 * 笔记模块当初 create 接口漏返回 attachments 就是这么来的。
 *
 * 另一层意义是**安全**：登录用的 `prisma.user.findUnique()` 返回的是
 * 整行记录，里面带着 `password` 哈希。如果直接把整行丢给前端，
 * 就是一个凭据泄露。这里用显式 select + 显式映射两道关卡，
 * 任意一处新增字段都不会自动流出去。
 */

/** 查用户公开信息时统一的 Prisma select */
export const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  nickname: true,
  handle: true,
  bio: true,
  createdAt: true,
} as const;

export interface PublicUser {
  id: string; // 用户主键
  email: string; // 登录邮箱，只有本人资料接口会返回
  nickname: string | null; // 昵称；没填时为 null，前端回退邮箱前缀展示
  /** 账号标识，展示为 @handle。老用户可能为空 */
  handle: string | null;
  /** 个性签名 */
  bio: string | null;
  createdAt: Date; // 注册时间；查询侧是 Date，出参是 ISO 字符串
}

/**
 * 收敛成接口出参。
 *
 * 只做 null 归一化（Prisma 的 String? 是 null，而调用方可能传 undefined），
 * 不做 trim —— 空字符串昵称由前端的 displayName 处理，
 * 在这里多改一次会让两端的判断逻辑分叉。
 */
export function toPublicUser(row: PublicUser): PublicUser {
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname ?? null,
    handle: row.handle ?? null,
    bio: row.bio ?? null,
    createdAt: row.createdAt,
  };
}
