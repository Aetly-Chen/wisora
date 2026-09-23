import React, { useEffect, useState } from 'react';
import { Loader2, Search, UserPlus } from 'lucide-react';
import type { Friend } from '@/types/chat';
import { useChatStore } from '@/stores/useChatStore';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar } from '@/components/Avatar';
import { peerAvatarClass } from '@/lib/chat-utils';

/**
 * 添加好友。
 *
 * 这个弹窗直接连 store（而不是由页面透传 props）：它需要
 * 搜索、添加、好友列表三份状态，全部透传会让页面多出六七个
 * 只为了往下递的 prop。展示型组件（列表 / 气泡 / 输入区）仍走 props。
 *
 * 搜索是「按需触发」的：空关键词不发请求，避免一打开弹窗
 * 就把全部用户拉一遍（后端也会因此被刷）。
 */

interface AddFriendDialogProps {
  open: boolean;
  onClose: () => void;
}

export const AddFriendDialog: React.FC<AddFriendDialogProps> = ({ open, onClose }) => {
  const findUsers = useChatStore((s) => s.findUsers);
  const addFriend = useChatStore((s) => s.addFriend);

  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Friend[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  /** 已搜索过但没结果，用于区分「还没搜」和「搜了没有」 */
  const [searched, setSearched] = useState(false);

  // 关闭时清空，下次打开是干净状态
  useEffect(() => {
    if (!open) {
      setKeyword('');
      setResults([]);
      setSearched(false);
    }
  }, [open]);

  const runSearch = async () => {
    const q = keyword.trim();
    if (!q) return;

    setSearching(true);
    try {
      setResults(await findUsers(q));
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md gap-3 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="text-[15px] font-medium text-tg-text">
            添加好友
          </DialogTitle>
          <DialogDescription className="text-[13px] text-tg-text-muted">
            按昵称、邮箱或账号前缀查找。
          </DialogDescription>
        </DialogHeader>

        <div className="px-5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tg-text-muted" />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                }}
                placeholder="输入昵称或邮箱"
                aria-label="搜索用户"
                className="w-full rounded-[10px] border border-tg-border bg-tg-surface py-2 pl-9 pr-3 text-[13px] text-tg-text-body placeholder:text-tg-text-muted focus:border-tg-brand focus:outline-none focus:ring-2 focus:ring-tg-brand-soft"
              />
            </div>
            <Button
              variant="brand"
              size="sm"
              className="rounded-[10px] bg-tg-brand-press text-[13px] hover:bg-tg-brand-deep"
              disabled={!keyword.trim() || searching}
              onClick={() => void runSearch()}
            >
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '搜索'}
            </Button>
          </div>
        </div>

        <div className="max-h-[42vh] overflow-y-auto px-2 pb-2">
          {searching ? (
            <div className="space-y-1 pt-1">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-2.5 px-2.5 py-2">
                  <div className="h-7 w-7 animate-pulse rounded-full bg-black/[0.06]" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-black/[0.06]" />
                </div>
              ))}
            </div>
          ) : results.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-tg-text-muted">
              {searched ? '没有找到该用户' : '输入账号后点搜索'}
            </p>
          ) : (
            results.map((friend) => (
              <div
                key={friend.id}
                className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 hover:bg-tg-surface-hover"
              >
                <Avatar
                  id={friend.id}
                  name={friend.name}
                  size="md"
                  presence={friend.presence}
                  fill={peerAvatarClass(friend.id)}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-tg-text-body">
                    {friend.name}
                  </p>
                  <p className="truncate text-[11.5px] text-tg-text-muted">
                    @{friend.handle} · {friend.bio}
                  </p>
                </div>
                {friend.isFriend ? (
                  <span className="shrink-0 text-[11.5px] text-tg-text-muted">
                    已是好友
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 rounded-[10px] border-tg-border text-[11.5px] text-tg-brand-deep hover:bg-tg-brand-soft hover:text-tg-brand-deep"
                    disabled={addingId === friend.id}
                    onClick={() => {
                      setAddingId(friend.id);
                      void addFriend(friend.id).finally(() => setAddingId(null));
                    }}
                  >
                    {addingId === friend.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <UserPlus className="mr-1 h-3.5 w-3.5" />
                        添加
                      </>
                    )}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
