// src/stores/useUserStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// 1. 定义状态和方法类型
interface UserState {
  username: string;
  token: string;
  isLoggedIn: boolean;
  login: (username: string, token: string) => void;
  logout: () => void;
}

// 2. 创建带持久化的 Store
export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      username: 'Guest',
      token: '',
      isLoggedIn: false,

      login: (username, token) =>
        set({ username, token, isLoggedIn: true }),

      logout: () =>
        set({ username: 'Guest', token: '', isLoggedIn: false }),
    }),
    {
      name: 'wisora-user-storage', // 存储到 localStorage 中的唯一 key 名称（必填）
      storage: createJSONStorage(() => localStorage), // 默认就是 localStorage，亦可切换为 sessionStorage
    }
  )
);