import React, { useEffect, useMemo, useState } from 'react';
import { Check, CheckCheck, FileText, Folder } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { SharedNotePayload } from '@/types/chat';
import { useChatStore } from '@/stores/useChatStore';
import { useCurrentUserId } from '@/lib/use-current-user';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar } from '@/components/Avatar';

/**
 * 把笔记 / 目录分享给好友。
 *
 * 由笔记页的右键菜单调用，也预留给聊天页复用，
 * 所以它不依赖任何笔记页的状态：只吃一个 `target` 快照。
 *
 * 一个容易漏的集成点：如果用户**没进过聊天页**就直接在笔记页分享，
 * 好友列表还是空的（store 尚未初始化）。这里在打开时补一次
 * ensureInit，否则弹窗会是"没有好友可选"的假空态。
 */

interface ShareToFriendDialogProps {
  /** 要分享的目标；null 表示关闭 */
  target: SharedNotePayload | null;
  onClose: () => void;
  /** 分享成功后跳去聊天页；传 false 表示不提供跳转入口 */
  allowJumpToChat?: boolean;
}

export const ShareToFriendDialog: React.FC<ShareToFriendDialogProps> = ({
  target,
  onClose,
  allowJumpToChat = true,
}) => {
  const navigate = useNavigate();

  const friends = useChatStore((s) => s.friends);
  const meId = useChatStore((s) => s.meId);
  const ensureInit = useChatStore((s) => s.init);
  const shareNote = useChatStore((s) => s.shareNote);

  // 当前登录用户 id：分享时要用它做 store 初始化
  const currentUserId = useCurrentUserId();

  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [sharing, setSharing] = useState(false);
  /** 分享成功后的送达人数；非 null 时展示成功态 */
  const [sentTo, setSentTo] = useState<number | null>(null);

  // 打开时补齐初始化：用户可能从没进过聊天页，好友列表此时是空的
  useEffect(() => {
    if (target && !meId && currentUserId) void ensureInit(currentUserId);
  }, [target, meId, currentUserId, ensureInit]);

  // 关闭时清空，下次打开是干净状态
  useEffect(() => {
    if (!target) {
      setSelected([]);
      setComment('');
      setSentTo(null);
    }
  }, [target]);

  const isFolder = target?.kind === 'folder';

  /**
   * 可以分享的好友：排除自己。
   * 群聊成员不做为分享对象，分享走的是单聊（与后端约定一致）。
   */
  const candidates = useMemo(
    () => friends.filter((f) => f.isFriend && f.id !== meId),
    [friends, meId],
  );

  const handleShare = async () => {
    if (!target || selected.length === 0) return;

    setSharing(true);
    const count = await shareNote({
      noteId: target.noteId,
      title: target.title,
      kind: target.kind,
      childCount: target.childCount,
      toFriendIds: selected,
      comment,
    });
    setSharing(false);

    if (count > 0) setSentTo(count);
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md gap-3 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="text-[15px] font-semibold text-slate-900">
            分享{isFolder ? '目录' : '笔记'}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5 text-[12.5px] text-slate-500">
            {isFolder ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
            )}
            <span className="truncate">{target?.title ?? ''}</span>
            {isFolder && (target?.childCount ?? 0) > 0 && (
              <span className="shrink-0 text-slate-400">
                · 含 {target?.childCount} 个子页面
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {sentTo !== null ? (
          /* 成功态：给出去聊天页的入口，否则用户不知道分享到哪去了 */
          <div className="px-5 pb-5">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3.5 text-center">
              <CheckCheck className="mx-auto mb-1.5 h-5 w-5 text-emerald-600" />
              <p className="text-[13px] font-medium text-emerald-800">
                已分享给 {sentTo} 位好友
              </p>
              <p className="mt-0.5 text-[11.5px] text-emerald-700/80">
                对方会在聊天里收到这张卡片
              </p>
            </div>

            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 rounded-lg border-slate-200 text-[12.5px]"
                onClick={onClose}
              >
                完成
              </Button>
              {allowJumpToChat && (
                <Button
                  variant="brand"
                  size="sm"
                  className="flex-1 rounded-lg text-[12.5px]"
                  onClick={() => {
                    onClose();
                    navigate('/chat');
                  }}
                >
                  去聊天查看
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="max-h-[38vh] overflow-y-auto px-2">
              {candidates.length === 0 ? (
                <p className="py-8 text-center text-[12.5px] text-slate-400">
                  还没有好友，先去聊天页添加
                </p>
              ) : (
                candidates.map((friend) => {
                  const checked = selected.includes(friend.id);
                  return (
                    <button
                      key={friend.id}
                      type="button"
                      onClick={() =>
                        setSelected((prev) =>
                          prev.includes(friend.id)
                            ? prev.filter((x) => x !== friend.id)
                            : [...prev, friend.id],
                        )
                      }
                      aria-pressed={checked}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        checked ? 'bg-indigo-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <Avatar
                        id={friend.id}
                        name={friend.name}
                        size="sm"
                        presence={friend.presence}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-slate-800">
                          {friend.name}
                        </span>
                        <span className="block truncate text-[11.5px] text-slate-500">
                          @{friend.handle}
                        </span>
                      </span>
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-slate-300'
                        }`}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div className="px-5">
              <label
                htmlFor="share-comment"
                className="mb-1 block text-[11.5px] font-medium text-slate-600"
              >
                附一句话（可选）
              </label>
              <textarea
                id="share-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                placeholder="例如：这份是性能优化的记录，你看下 longtask 那段"
                className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px] text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>

            <div className="flex gap-2 px-5 pb-5">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 rounded-lg border-slate-200 text-[12.5px]"
                onClick={onClose}
              >
                取消
              </Button>
              <Button
                variant="brand"
                size="sm"
                className="flex-1 rounded-lg text-[12.5px]"
                disabled={selected.length === 0 || sharing}
                onClick={() => void handleShare()}
              >
                {sharing
                  ? '分享中…'
                  : selected.length > 0
                    ? `分享给 ${selected.length} 位好友`
                    : '选择好友'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
