import React, { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import type { Friend } from '@/types/chat';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PeerAvatar } from './PeerAvatar';

/**
 * 新建聊天：单聊与群聊合一。
 *
 * 放同一个弹窗的两个页签里，而不是两个入口 ——
 * 用户的意图都是「找个人说话」，多一步选类型只是多一次点击。
 *
 * 群聊至少要选 1 人才能建（加上自己就是 2 人），
 * 这个约束在按钮的禁用态上直接体现，不要等到点了才报错。
 */

interface NewChatDialogProps {
  open: boolean;
  friends: Friend[];
  onClose: () => void;
  onStartDirect: (friendId: string) => void;
  onStartGroup: (payload: { title: string; memberIds: string[] }) => void;
}

export const NewChatDialog: React.FC<NewChatDialogProps> = ({
  open,
  friends,
  onClose,
  onStartDirect,
  onStartGroup,
}) => {
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState('');

  const matched = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter(
      (f) => f.name.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q),
    );
  }, [friends, keyword]);

  const reset = () => {
    setKeyword('');
    setSelected([]);
    setGroupTitle('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="text-[15px] font-semibold text-slate-900">
            新建聊天
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-slate-500">
            选择联系人开始单聊，或勾选多人创建群聊。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="direct" className="px-5 pt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="direct" className="text-[12.5px]">
              单聊
            </TabsTrigger>
            <TabsTrigger value="group" className="text-[12.5px]">
              群聊
            </TabsTrigger>
          </TabsList>

          {/* 搜索在两种模式下共用，所以放在 TabsList 下面而不是各自的 Content 里 */}
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索姓名或 @账号"
              aria-label="搜索联系人"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-[12.5px] text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <TabsContent value="direct" className="mt-2">
            <div className="max-h-[46vh] overflow-y-auto">
              {matched.length === 0 ? (
                <p className="py-8 text-center text-[12.5px] text-slate-400">
                  没有匹配的联系人
                </p>
              ) : (
                matched.map((friend) => (
                  <button
                    key={friend.id}
                    type="button"
                    onClick={() => {
                      onStartDirect(friend.id);
                      close();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-slate-50"
                  >
                    <PeerAvatar
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
                  </button>
                ))
              )}
            </div>
          </TabsContent>

          <TabsContent value="group" className="mt-2 space-y-3">
            <div>
              <label
                htmlFor="group-title"
                className="mb-1 block text-[11.5px] font-medium text-slate-600"
              >
                群聊名称
              </label>
              <input
                id="group-title"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                placeholder="例如：Wisora 前端组"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px] text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>

            <div>
              <p className="mb-1 text-[11.5px] font-medium text-slate-600">
                选择成员
                {selected.length > 0 && (
                  <span className="ml-1.5 font-normal text-slate-400">
                    已选 {selected.length} 人
                  </span>
                )}
              </p>
              <div className="max-h-[32vh] overflow-y-auto rounded-lg border border-slate-200/80">
                {matched.length === 0 ? (
                  <p className="py-6 text-center text-[12.5px] text-slate-400">
                    没有匹配的联系人
                  </p>
                ) : (
                  matched.map((friend) => {
                    const checked = selected.includes(friend.id);
                    return (
                      <button
                        key={friend.id}
                        type="button"
                        onClick={() => toggle(friend.id)}
                        aria-pressed={checked}
                        className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors ${
                          checked ? 'bg-indigo-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <PeerAvatar
                          id={friend.id}
                          name={friend.name}
                          size="sm"
                          presence={friend.presence}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-slate-700">
                          {friend.name}
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
            </div>

            <Button
              variant="brand"
              size="sm"
              className="w-full rounded-lg text-[12.5px]"
              disabled={selected.length === 0}
              onClick={() => {
                onStartGroup({ title: groupTitle, memberIds: selected });
                close();
              }}
            >
              创建群聊{selected.length > 0 ? `（${selected.length + 1} 人）` : ''}
            </Button>
          </TabsContent>
        </Tabs>

        <div className="px-5 pb-5 pt-3" />
      </DialogContent>
    </Dialog>
  );
};
