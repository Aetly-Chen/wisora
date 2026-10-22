import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, FolderInput, Pin, PinOff, Plus, Search, Share2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VirtualList } from '@/components/VirtualList';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { flattenNotes, subtreeIds, useNotesStore } from '@/stores/useNotesStore';
import type { NoteSummary } from '@/types/note';
import type { SharedNotePayload } from '@/types/chat';
import { NoteTreeItem } from './NoteTreeItem';
import { MoveNoteDialog } from './MoveNoteDialog';

/**
 * 侧边栏：搜索 + 目录树 + 新建。
 *
 * 拖拽移动、右键菜单、「移动到…」弹窗都是**这里独有**的交互 ——
 * 它们的状态（谁在拖、拖到谁上面、弹窗为谁打开）不需要让页面知道，
 * 所以整块收在这个组件里，页面只负责「开/关」和「要分享」。
 */
export const NoteSidebar: React.FC<{
  open: boolean;
  onClose: () => void;
  onShare: (payload: SharedNotePayload) => void;
}> = ({ open, onClose, onShare }) => {
  const {
    notes,
    keyword,
    listLoading,
    expanded,
    selectedId,
    activeId,
    setKeyword,
    toggleExpanded,
    openNote,
    createNote,
    togglePin,
    removeNote,
    moveNote,
  } = useNotesStore();

  /** 正在被拖动的笔记 id（拖拽移动） */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 当前悬停的落点 id，用于高亮 */
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /** 「移动到…」弹窗的源笔记 id */
  const [moveSourceId, setMoveSourceId] = useState<string | null>(null);
  /** 右键菜单：坐标 + 目标行 */
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    note: NoteSummary;
  } | null>(null);

  /*
   * 树摊平。
   *
   * 搜索时走扁平行：命中项散落在各层，硬接回原树会出现一堆
   * 「父级没命中却因为子级命中而冒出来」的中间节点，反而更难读。
   */
  const treeRows = useMemo(
    () => flattenNotes(notes, expanded, !!keyword.trim()),
    [notes, expanded, keyword],
  );

  /**
   * 非法的移动落点：自己 + 自己的全部后代。
   *
   * 把 A 移到 A 的后代下会形成环（A 的父是 B、B 的父是 A），
   * 两棵子树互相嵌套后谁也遍历不出来，侧边栏里会整片消失。
   * 后端也有同样的校验，这里挡一道是为了不给出会失败的交互暗示。
   */
  const invalidMoveTargets = useMemo(
    () => (draggingId ? subtreeIds(notes, draggingId) : new Set<string>()),
    [draggingId, notes],
  );

  /** 移动弹窗用的完整树（全部展开，不跟随侧边栏的收起状态） */
  const movePickerRows = useMemo(() => {
    const allExpanded = Object.fromEntries(notes.map((n) => [n.id, true]));
    return flattenNotes(notes, allExpanded);
  }, [notes]);

  const moveSource = moveSourceId ? notes.find((n) => n.id === moveSourceId) : undefined;
  const moveSourceSubtree = useMemo(
    () => (moveSourceId ? subtreeIds(notes, moveSourceId) : new Set<string>()),
    [moveSourceId, notes],
  );

  const handleMove = (id: string, parentId: string | null) => {
    void moveNote(id, parentId);
  };

  /**
   * 右键菜单项。
   *
   * 与行内 hover 按钮是两条并列的入口，不是替代关系：
   * hover 按钮给高频的三个操作（移动 / 新建子页面 / 删除），
   * 右键菜单给完整清单 —— 分享、置顶这些操作没有位置放进
   * 一行里（行内已经挤了三个按钮），右键是它们唯一的入口。
   */
  const rowMenuItems: ContextMenuItem[] = rowMenu
    ? (() => {
        const { note } = rowMenu;
        // 有子页面就算「目录」。分享给好友时卡片上会注明含几个子页面
        const descendants = subtreeIds(notes, note.id).size - 1;
        const kind: SharedNotePayload['kind'] = descendants > 0 ? 'folder' : 'note';

        return [
          {
            id: 'open',
            label: '打开',
            onSelect: () => void openNote(note.id),
          },
          {
            id: 'add-child',
            label: '新建子页面',
            icon: Plus,
            group: 'edit',
            onSelect: () => void createNote(note.id),
          },
          {
            id: 'move',
            label: '移动到…',
            icon: FolderInput,
            group: 'edit',
            onSelect: () => setMoveSourceId(note.id),
          },
          {
            id: 'share',
            label: '分享给好友',
            icon: Share2,
            group: 'share',
            onSelect: () =>
              onShare({
                noteId: note.id,
                title: note.title || '无标题',
                kind,
                childCount: descendants,
              }),
          },
          {
            id: 'pin',
            label: note.pinned ? '取消置顶' : '置顶',
            icon: note.pinned ? PinOff : Pin,
            group: 'share',
            onSelect: () => void togglePin(note.id),
          },
          {
            id: 'delete',
            label: descendants > 0 ? `删除（含 ${descendants} 个子页面）` : '删除',
            icon: Trash2,
            danger: true,
            onSelect: () => void removeNote(note.id),
          },
        ] satisfies ContextMenuItem[];
      })()
    : [];

  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-[276px] flex-col border-r border-slate-200/80 bg-[#f6f5f2] transition-transform md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 px-4 pb-3 pt-4">
          <Link
            to="/"
            aria-label="返回首页"
            title="返回首页"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-900/5 hover:text-slate-700"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">笔记</h1>
          <span className="text-[11.5px] text-slate-400">{notes.length}</span>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="关闭列表"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-900/5 md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
          <Button
            size="sm"
            variant="brand"
            className="h-8 rounded-lg px-3 text-[12.5px]"
            title={selectedId ? '作为选中目录的子页面' : '新建一级目录'}
            onClick={() => {
              void createNote();
              onClose();
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {selectedId ? '新建子页面' : '新建'}
          </Button>
        </div>

        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索标题或正文"
              className="h-9 rounded-lg border-slate-200 bg-white pl-8 text-[13px] placeholder:text-slate-400"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
          {listLoading && notes.length === 0 ? (
            <div className="space-y-1 px-1 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-900/[0.045]" />
              ))}
            </div>
          ) : treeRows.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <p className="text-[13px] text-slate-500">
                {keyword ? '没有匹配的笔记' : '还没有笔记'}
              </p>
              {!keyword && (
                <button
                  type="button"
                  onClick={() => void createNote(null)}
                  className="mt-2 text-[12.5px] text-indigo-600 hover:underline"
                >
                  新建第一篇
                </button>
              )}
            </div>
          ) : (
            <VirtualList
              count={treeRows.length}
              className="min-h-0 flex-1 overflow-y-auto pr-1"
              data-testid="notes-tree"
              renderRow={(index) => {
                const row = treeRows[index];
                const note = row.note;
                return (
                  <NoteTreeItem
                    row={row}
                    active={note.id === activeId}
                    expanded={!!expanded[note.id]}
                    dragging={draggingId === note.id}
                    dragOver={dragOverId === note.id}
                    invalidTarget={invalidMoveTargets.has(note.id)}
                    selected={note.id === selectedId}
                    onToggle={() => toggleExpanded(note.id)}
                    onOpen={() => {
                      void openNote(note.id);
                      onClose();
                    }}
                    onAddChild={() => void createNote(note.id)}
                    onDelete={() => void removeNote(note.id)}
                    onMoveRequest={() => setMoveSourceId(note.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setRowMenu({ x: e.clientX, y: e.clientY, note });
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/note-id', note.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDraggingId(note.id);
                    }}
                    onDragOverRow={(e) => {
                      // 没有拖动源 / 落点是非法目标时不接受 —— 不 preventDefault
                      // 浏览器就不会显示可放置光标，交互上更诚实
                      if (!draggingId || invalidMoveTargets.has(note.id)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dragOverId !== note.id) setDragOverId(note.id);
                    }}
                    onDragLeaveRow={() => {
                      setDragOverId((cur) => (cur === note.id ? null : cur));
                    }}
                    onDropRow={(e) => {
                      const sourceId = e.dataTransfer.getData('text/note-id');
                      setDraggingId(null);
                      setDragOverId(null);
                      if (!sourceId || sourceId === note.id) return;
                      if (invalidMoveTargets.has(note.id)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      handleMove(sourceId, note.id);
                    }}
                  />
                );
              }}
            />
          )}

          {/* 顶层页面的固定入口：头部按钮在「有打开的页面」时会变成新建子页面，
              这里是唯一能随时建顶层页面的地方 */}
          {!keyword && (
            <button
              type="button"
              onClick={() => void createNote(null)}
              className="mt-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-[12.5px] text-slate-500 transition-colors hover:bg-slate-900/[0.035] hover:text-slate-700"
            >
              <Plus className="h-3.5 w-3.5" />
              新建顶层页面
            </button>
          )}
        </div>
      </aside>

      {/* 目录树的右键菜单 */}
      <ContextMenu
        open={!!rowMenu}
        x={rowMenu?.x ?? 0}
        y={rowMenu?.y ?? 0}
        items={rowMenuItems}
        onClose={() => setRowMenu(null)}
      />

      <MoveNoteDialog
        source={moveSource ?? null}
        rows={movePickerRows}
        blocked={moveSourceSubtree}
        onMove={handleMove}
        onClose={() => setMoveSourceId(null)}
      />
    </>
  );
};
