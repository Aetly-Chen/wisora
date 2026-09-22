import { useEffect } from 'react';
import { useUserStore } from '@/stores/useAppStore';
import { getUserProfile } from '@/request/api';
import { getToken } from '@/request/storage';

/**
 * 拿到当前登录用户 id，必要时回查资料补齐。
 *
 * 为什么需要它：用户 id 存在 localStorage 里（persist 中间件），
 * 但「只有 token、没有用户资料」是一个真实存在的状态 ——
 * 换浏览器导入旧 localStorage、清了存储只留令牌、或者持久化的结构
 * 变过一版，都会落到这里。聊天模块要用 id 区分「我发的」和「别人发的」，
 * 拿不到 id 就会卡在空态且没有任何提示。
 *
 * 这个兜底与 AI 助手页处理昵称的做法一致：缺什么就按令牌回查一次。
 * 请求本身走 `loading: false`，不触发全局加载遮罩（它只是补数据，
 * 不该打断用户已经在做的事）。
 *
 * 返回空字符串表示还没拿到；调用方应据此走加载态而不是当成"没有数据"。
 */
export function useCurrentUserId(): string {
  const userId = useUserStore((s) => s.userId);
  const setUser = useUserStore((s) => s.setUser);

  useEffect(() => {
    if (userId) return;

    /*
     * 没有令牌就别查。
     *
     * 退出登录时 logout() 会先删令牌再清用户状态，而清用户状态会让
     * 所有用到这个 hook 的组件重渲染 —— 如果这里不判断，它会立刻拿着
     * 已经不存在的令牌去请求 /user/profile：必然 401，还会连带触发
     * 一次无意义的 /auth/refresh，在控制台留下两行红字。
     * 未登录状态下打开页面同理。
     */
    if (!getToken()) return;

    let cancelled = false;
    void getUserProfile()
      .then((user) => {
        // 组件已卸载或期间已经拿到了 id 就不覆盖
        if (!cancelled && user) setUser(user);
      })
      .catch(() => {
        // 静默失败：令牌无效时全局拦截器会负责跳登录，
        // 这里再弹一次错误只会重复提示
      });

    return () => {
      cancelled = true;
    };
  }, [userId, setUser]);

  return userId;
}
