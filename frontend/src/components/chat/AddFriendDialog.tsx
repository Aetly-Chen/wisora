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
import { PeerAvatar } from './PeerAvatar';

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
          <DialogTitle className="text-[15px] font-semibold text-slate-900">
            添加好友
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-slate-500">
            输入对方的 @账号或姓名来查找。
          </DialogDescription>
        </DialogHeader>

        <div className="px-5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                }}
                placeholder="例如 yanzhou.shen"
                aria-label="搜索用户"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-[12.5px] text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <Button
              variant="brand"
              size="sm"
              className="rounded-lg text-[12.5px]"
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
                  <div className="h-7 w-7 animate-pulse rounded-full bg-slate-900/[0.05]" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-slate-900/[0.05]" />
                </div>
              ))}
            </div>
          ) : results.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-slate-400">
              {searched ? '没有找到该用户' : '输入账号后点搜索'}
            </p>
          ) : (
            results.map((friend) => (
              <div
                key={friend.id}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-slate-50"
              >
                <PeerAvatar
                  id={friend.id}
                  name={friend.name}
                  size="sm"
                  presence={friend.presence}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-slate-800">
                    {friend.name}
                  </p>
                  <p className="truncate text-[11.5px] text-slate-500">
                    @{friend.handle} · {friend.bio}
                  </p>
                </div>
                {friend.isFriend ? (
                  <span className="shrink-0 text-[11.5px] text-slate-400">已是好友</span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 rounded-lg border-slate-200 text-[11.5px]"
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
