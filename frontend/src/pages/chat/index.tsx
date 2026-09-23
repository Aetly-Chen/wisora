import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MessageSquarePlus, UserPlus, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useChatStore, visibleConversations } from '@/stores/useChatStore';
import { useUserStore } from '@/stores/useAppStore';
import { useCurrentUserId } from '@/lib/use-current-user';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { Avatar } from '@/components/Avatar';
import { peerAvatarClass } from '@/lib/chat-utils';
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageList } from '@/components/chat/MessageList';
import { Composer } from '@/components/chat/Composer';
import { NewChatDialog } from '@/components/chat/NewChatDialog';
import { AddFriendDialog } from '@/components/chat/AddFriendDialog';
import type { Conversation } from '@/types/chat';

/**
 * 聊天页：整屏工作区，Telegram 风格。
 *
 * 布局与 /agent、/notes 一致（都是 h-[100dvh] + 隐藏全局导航），
 * 所以从任一工作区切过来不会有"页面突然变矮"的跳动。
 *
 * 与那两个工作区不同的是配色：这里整套走 Telegram 的令牌
 * （--tg-*，见 index.css），不再用项目的暖白 + indigo。
 * 壁纸挂在 <main> 上而不是消息滚动容器上 —— 滚动时背景要不动。
 *
 * 移动端是「列表 ↔ 会话」的两态切换而不是左右压缩：
 * 两个 320px 的栏并排在手机上没法用，Telegram 也是这么处理的。
 */

const ChatPage: React.FC = () => {
  const navigate = useNavigate();

  const meId = useChatStore((s) => s.meId);
  const friends = useChatStore((s) => s.friends);
  const conversations = useChatStore((s) => s.conversations);
  const messagesByConversation = useChatStore((s) => s.messagesByConversation);
  const activeId = useChatStore((s) => s.activeId);
  const keyword = useChatStore((s) => s.keyword);
  const listLoading = useChatStore((s) => s.listLoading);
  const messagesLoading = useChatStore((s) => s.messagesLoading);
  const typing = useChatStore((s) => s.typing);
  const drafts = useChatStore((s) => s.drafts);
  const upload = useChatStore((s) => s.upload);
  const error = useChatStore((s) => s.error);
  const notice = useChatStore((s) => s.notice);

  const init = useChatStore((s) => s.init);
  const dispose = useChatStore((s) => s.dispose);
  const setKeyword = useChatStore((s) => s.setKeyword);
  const setDraft = useChatStore((s) => s.setDraft);
  const openConversation = useChatStore((s) => s.openConversation);
  const send = useChatStore((s) => s.send);
  const attachAndSend = useChatStore((s) => s.attachAndSend);
  const retryMessage = useChatStore((s) => s.retryMessage);
  const startDirect = useChatStore((s) => s.startDirect);
  const startGroup = useChatStore((s) => s.startGroup);
  const togglePin = useChatStore((s) => s.togglePin);
  const toggleMute = useChatStore((s) => s.toggleMute);
  const clearError = useChatStore((s) => s.clearError);
  const clearNotice = useChatStore((s) => s.clearNotice);

  // 缺用户资料时会按令牌回查一次，拿不到就走加载态
  const currentUserId = useCurrentUserId();
  const username = useUserStore((s) => s.username);
  const email = useUserStore((s) => s.email);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    conversation: Conversation;
  } | null>(null);
  const [sending, setSending] = useState(false);

  // 初始化：拉好友与会话，并订阅实时事件
  useEffect(() => {
    if (!currentUserId) return;
    void init(currentUserId);
    return () => dispose();
  }, [currentUserId, init, dispose]);

  const activeConversation = conversations.find((c) => c.id === activeId);

  const filtered = useMemo(
    () => visibleConversations(conversations, keyword, friends, meId),
    [conversations, keyword, friends, meId],
  );

  const activeMessages = useMemo(
    () => (activeId ? (messagesByConversation[activeId] ?? []) : []),
    [messagesByConversation, activeId],
  );

  const draft = activeId ? (drafts[activeId] ?? '') : '';

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    await send({ text: draft });
    setSending(false);
  };

  const handleOpen = (id: string) => {
    void openConversation(id);
    // 移动端：选中会话后把列表收起，让出全部宽度
    setSidebarOpen(false);
  };

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          id: 'pin',
          label: menu.conversation.pinned ? '取消置顶' : '置顶会话',
          onSelect: () => void togglePin(menu.conversation.id),
        },
        {
          id: 'mute',
          label: menu.conversation.muted ? '取消免打扰' : '开启免打扰',
          onSelect: () => void toggleMute(menu.conversation.id),
        },
        {
          id: 'open',
          label: '打开会话',
          group: 'nav',
          onSelect: () => handleOpen(menu.conversation.id),
        },
      ]
    : [];

  return (
    <div
      className="tg-app flex h-[100dvh] text-tg-text-body"
      data-testid="chat-root"
    >
      {/* ================= 左：会话列表 ================= */}
      <aside
        className={`${
          sidebarOpen ? 'flex' : 'hidden'
        } absolute inset-y-0 left-0 z-30 w-[320px] shrink-0 flex-col border-r border-tg-border-subtle bg-tg-surface md:static md:flex`}
      >
        <div className="flex items-center gap-1 px-3 py-2.5">
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="返回首页"
            title="返回首页"
            className="rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <h1 className="text-[17px] font-medium text-tg-text">聊天</h1>

          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setShowAddFriend(true)}
              aria-label="添加好友"
              title="添加好友"
              className="rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover"
            >
              <UserPlus className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setShowNewChat(true)}
              aria-label="新建聊天"
              title="新建聊天"
              className="rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover"
            >
              <MessageSquarePlus className="h-5 w-5" />
            </button>
            {/* 移动端抽屉的关闭按钮 */}
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="收起会话列表"
              className="rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <ConversationList
          conversations={filtered}
          friends={friends}
          meId={meId}
          activeId={activeId}
          loading={listLoading}
          keyword={keyword}
          typing={typing}
          onKeywordChange={setKeyword}
          onOpen={handleOpen}
          onNewChat={() => setShowNewChat(true)}
          onContextMenu={(e, conversation) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, conversation });
          }}
        />

        {/* 当前用户：点进个人资料。
            与 AI 助手页底部同一种呈现方式，两处都通向 /profile ——
            同一个东西点了要有同一个结果。 */}
        <div className="border-t border-tg-border-subtle p-2.5">
          <Link
            to="/profile"
            title="个人资料"
            className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 transition-colors hover:bg-tg-surface-hover"
          >
            <Avatar
              id={meId || 'me'}
              name={username || '我'}
              size="lg"
              fill={peerAvatarClass(meId || 'me')}
            />
            <div className="min-w-0">
              <p className="truncate text-[14px] font-medium text-tg-text">
                {username || '我'}
              </p>
              <p className="truncate text-[12px] text-tg-text-muted">
                {email || '查看个人资料'}
              </p>
            </div>
          </Link>
        </div>
      </aside>

      {/* 移动端展开列表时的遮罩 */}
      {sidebarOpen && (
        <div
          className="absolute inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* ================= 右：会话区 ================= */}
      <main className="tg-wallpaper flex min-w-0 flex-1 flex-col">
        {activeConversation ? (
          <>
            <ChatHeader
              conversation={activeConversation}
              friends={friends}
              meId={meId}
              typingName={
                (typing[activeConversation.id] ?? []).length > 0
                  ? friends.find((f) => f.id === typing[activeConversation.id][0])?.name
                  : undefined
              }
              onBack={() => setSidebarOpen(true)}
              onTogglePin={() => void togglePin(activeConversation.id)}
              onToggleMute={() => void toggleMute(activeConversation.id)}
            />

            <MessageList
              conversation={activeConversation}
              messages={activeMessages}
              friends={friends}
              meId={meId}
              loading={messagesLoading}
              typingUserIds={typing[activeConversation.id] ?? []}
              onRetry={(id) => void retryMessage(id)}
              onOpenNote={(noteId) => navigate(`/notes?note=${noteId}`)}
            />

            <Composer
              value={draft}
              onChange={(value) => setDraft(activeConversation.id, value)}
              onSubmit={() => void handleSend()}
              disabled={false}
              sending={sending}
              upload={upload}
              onAttachFile={(file) => void attachAndSend(file)}
            />
          </>
        ) : (
          /* 没有选中会话：给一个能立刻行动的引导，而不是空白 */
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/70">
              <MessageSquarePlus className="h-6 w-6 text-tg-brand-press" />
            </div>
            <h2 className="mt-4 text-[15px] font-medium text-tg-text-body">
              选择一个会话开始
            </h2>
            <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed tg-wallpaper-text">
              左侧是全部会话。也可以在笔记里右键一篇笔记，直接分享给好友。
            </p>
            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowNewChat(true)}
                className="rounded-full bg-tg-brand-press px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-tg-brand-deep"
              >
                新建聊天
              </button>
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="rounded-full bg-white/85 px-4 py-2 text-[13px] font-medium text-tg-text-body transition-colors hover:bg-white md:hidden"
              >
                查看会话列表
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ================= 浮层 ================= */}
      <ContextMenu
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />

      <NewChatDialog
        open={showNewChat}
        friends={friends}
        onClose={() => setShowNewChat(false)}
        onStartDirect={(friendId) => void startDirect(friendId)}
        onStartGroup={(payload) => void startGroup(payload)}
      />

      <AddFriendDialog open={showAddFriend} onClose={() => setShowAddFriend(false)} />

      {/* 提示条：错误优先，与笔记页同一套呈现，只换成本页的配色 */}
      {(error || notice) && (
        <div
          className={`fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[10px] border bg-tg-surface px-4 py-2.5 text-[13px] shadow-[0_4px_16px_rgb(0_0_0/0.16)] md:bottom-5 ${
            error
              ? 'border-tg-danger/30 text-tg-danger'
              : 'border-tg-online/35 text-tg-text-body'
          }`}
        >
          <span className="max-w-[70vw]">{error || notice}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => (error ? clearError() : clearNotice())}
            className="rounded p-0.5 text-tg-text-muted hover:text-tg-text-body"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

export default ChatPage;
