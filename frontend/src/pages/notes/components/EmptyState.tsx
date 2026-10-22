import React from 'react';
import { FileText, FileUp, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** 没打开任何笔记时的空状态：新建 / 导入两条路 */
export const EmptyState: React.FC<{
  onCreate: () => void;
  onImport: () => void;
  importing: boolean;
}> = ({ onCreate, onImport, importing }) => (
  <div className="flex flex-1 items-center justify-center px-6">
    <div className="max-w-md text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900/[0.04]">
        <FileText className="h-5 w-5 text-slate-400" />
      </div>
      <h2 className="text-[15px] font-medium text-slate-700">还没有打开笔记</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
        从左侧选择一篇，或者新建一篇。
        <br />
        也可以直接把 <span className="font-medium text-slate-600">Markdown / HTML / 文本</span>
        文件拖到页面任意位置导入。
      </p>
      <div className="mt-5 flex items-center justify-center gap-2">
        <Button variant="brand" size="sm" className="rounded-lg text-[13px]" onClick={onCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          新建笔记
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="rounded-lg border-slate-200 text-[13px]"
          disabled={importing}
          onClick={onImport}
        >
          {importing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileUp className="mr-1.5 h-3.5 w-3.5" />
          )}
          导入文件
        </Button>
      </div>
    </div>
  </div>
);
