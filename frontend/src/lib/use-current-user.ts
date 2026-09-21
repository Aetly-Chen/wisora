import { useEffect } from 'react';
import { useUserStore } from '@/stores/useAppStore';
import { getUserProfile } from '@/request/api';

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
