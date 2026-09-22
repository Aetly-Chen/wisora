import { removeRefreshToken, removeToken } from '@/request/storage';
import { useUserStore } from '@/stores/useAppStore';
import { useAgentStore } from '@/stores/useAgentStore';
import { useChatStore } from '@/stores/useChatStore';
import { useNotesStore } from '@/stores/useNotesStore';

/**
 * 退出登录。
 *
 * 除了清令牌，还必须清掉内存里三个数据 store —— 它们不在持久化范围里，
 * 但会随 SPA 的整个生命周期存活：只清令牌的话，下一个登录的人
 * 进 /notes 会直接看到上一个人的笔记，进 /chat 会看到上一个人的聊天记录。
 * 这是那种「自己测不出来、换个账号就穿帮」的问题。
 *
 * 关于服务端：项目目前没有 logout 接口，也没有令牌黑名单 ——
 * accessToken 在 15 分钟内仍然有效（refreshToken 7 天）。
 * 对单机开发够用；如果以后要做真正的「立即失效」，需要把已登出的
 * jti 写进 Redis 并在守卫里校验，那是一次单独的改动。
 */
export function logout(): void {
  // 先断开实时连接：否则 socket.io 会带着已失效的令牌不断重连，
  // 控制台会持续刷「实时连接失败」
  useChatStore.getState().reset();
  useAgentStore.getState().reset();
  useNotesStore.getState().reset();

  removeToken();
  removeRefreshToken();

  useUserStore.getState().clearUser();
}
