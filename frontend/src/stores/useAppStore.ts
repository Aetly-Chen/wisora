// src/stores/useAppStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** 后端返回的用户信息（登录响应与 /user/profile 同构） */
export interface AuthUser {
  id: string;
  email: string;
  nickname: string | null;
}

interface UserState {
  userId: string;
  /** 显示名：优先昵称，没有昵称时退化为邮箱前缀 */
  username: string;
  email: string;
  isLoggedIn: boolean;

  /** 登录成功后写入；页面刷新时也由资料接口回填 */
  setUser: (user: AuthUser) => void;
  clearUser: () => void;
}

/** 昵称为空时不显示空白，退化用邮箱前缀，最后兜底成「用户」 */
export function displayName(user: AuthUser): string {
  const nickname = user.nickname?.trim();
  if (nickname) return nickname;
  const local = user.email.split('@')[0]?.trim();
  return local || '用户';
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      userId: '',
      // 早先默认值写死为 'Guest' 且 login() 从未被调用，
      // 导致侧边栏永远显示 Guest。现在留空，由真实数据填充。
      username: '',
      email: '',
      isLoggedIn: false,

      setUser: (user) =>
        set({
          userId: user.id,
          username: displayName(user),
          email: user.email,
          isLoggedIn: true,
        }),

      clearUser: () =>
        set({ userId: '', username: '', email: '', isLoggedIn: false }),
    }),
    {
      name: 'wisora-user-storage',
      storage: createJSONStorage(() => localStorage),
      // 令牌由 request/storage 单独管理（TOKEN / REFRESH_TOKEN），
      // 这里不再重复存一份，避免两处不一致
      partialize: (state) => ({
        userId: state.userId,
        username: state.username,
        email: state.email,
        isLoggedIn: state.isLoggedIn,
      }),
    },
  ),
);
