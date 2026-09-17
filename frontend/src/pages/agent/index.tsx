import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUserStore } from "@/stores/useAppStore";
import { useAgentStore } from "@/stores/useAgentStore";
import {
  Send,
  Plus,
  Square,
  X,
  MessageSquare,
  Clock,
  Sparkles,
  PanelLeft,
  Lightbulb,
  ArrowLeft,
  Trash2,
  Loader2,
  NotebookPen,
} from "lucide-react";

/**
 * 固定行高的轻量虚拟列表。
 *
 * 会话历史可能积累到几千条，全量渲染会让侧边栏首屏变慢、
 * 滚动掉帧。这里只渲染视口内的行 + 上下各 OVERSCAN 行缓冲。
 *
 * 为什么自己写而不引第三方：列表行高固定、无需动态测量，
 * 核心逻辑不到 30 行；为这点功能增加一个运行时依赖不划算。
 * 注意 ROW_HEIGHT 必须与实际行高严格一致，否则滚动位置会漂移。
 */
const ROW_HEIGHT = 44;
const OVERSCAN = 6;

const VirtualList: React.FC<{
  count: number;
  renderRow: (index: number) => React.ReactNode;
  className?: string;
  empty?: React.ReactNode;
}> = ({ count, renderRow, className, empty }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  /**
   * 滚动容器必须始终挂载，空状态也放在它内部。
   *
   * 曾经写成 `if (count === 0) return empty`，导致首次进入页面时
   * （会话列表还没拉到、count 为 0）容器根本没渲染，ref.current 为 null，
   * 这个 effect 直接退出且不会再跑；等数据到达容器才挂载，
   * 但依赖数组是空的不会重跑 —— viewportHeight 永远是 0，
   * 虚拟窗口算得过小，滚动到后面会露出大片空白。
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setViewportHeight(el.clientHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    count,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} style={{ height: ROW_HEIGHT }}>
        {renderRow(i)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className={className}
      data-virtual-scroll
    >
      {count === 0 ? (
        empty
      ) : (
        <div style={{ height: count * ROW_HEIGHT, position: "relative" }}>
          <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>{rows}</div>
        </div>
      )}
    </div>
  );
};

/**
 * 输入框必须定义在组件外部。
 *
 * 若写在 AgentPage 内部，每次 setState 都会生成新的函数身份，
 * React 会认为组件类型变了而卸载重挂整棵子树，导致 <input> 丢失焦点
 * —— 表现就是"一次只能输入一个字符"。
 */
interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  isStreaming: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  floating?: boolean;
}

const InputBar: React.FC<InputBarProps> = ({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  inputRef,
  floating = false,
}) => (
  <form onSubmit={onSubmit} className="w-full max-w-2xl mx-auto">
    <div
      className={`relative flex items-end gap-2 bg-white border border-slate-200/80 shadow-sm ${
        floating ? "rounded-full" : "rounded-3xl"
      } px-2 py-2 transition-shadow focus-within:shadow-md focus-within:border-slate-300`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 shrink-0"
        title="添加附件"
      >
        <Plus className="w-5 h-5" />
      </Button>

      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="有问题，随便问"
        disabled={isStreaming}
        className="flex-1 border-0 bg-transparent text-slate-800 placeholder:text-slate-400 focus-visible:ring-0 focus-visible:ring-offset-0 px-1 py-2 shadow-none min-w-0"
      />

      <div className="flex items-center gap-1 shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 hidden sm:inline-flex"
          title="深度思考"
        >
          <Lightbulb className="w-4 h-4" />
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 hidden sm:inline-flex"
          title="语音输入"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
            <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
            <path d="M17 11a1 1 0 0 0-2 0 3 3 0 0 1-6 0 1 1 0 0 0-2 0 5 5 0 0 0 10 0Z" />
            <path d="M12 17a1 1 0 0 0-1 1v3a1 1 0 0 0 2 0v-3a1 1 0 0 0-1-1Z" />
          </svg>
        </Button>

        {isStreaming ? (
          /* 生成中：显示停止按钮。点击会 abort fetch，
             后端收到连接断开会中断 LLM 请求，停止继续计费 */
          <Button
            type="button"
            variant="brand"
            size="icon"
            onClick={onStop}
            title="停止生成"
            aria-label="停止生成"
            className="h-9 w-9 rounded-full shrink-0"
          >
            <Square className="w-4 h-4 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            variant="brand"
            size="icon"
            disabled={!value.trim()}
            className="h-9 w-9 rounded-full shrink-0 disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  </form>
);

/**
 * 会话历史的一行。
 *
 * 提到模块顶层（而非在 AgentPage 内定义）：
 * 组件内定义组件会让 React 每次渲染都认为是新类型，卸载重挂整棵子树。
 */
const ConversationRow: React.FC<{
  title: string;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}> = ({ title, active, busy, onOpen, onDelete }) => (
  <div
    className={`group flex h-full items-center rounded-lg transition-colors ${
      active ? "bg-slate-200/70" : "hover:bg-slate-200/60"
    }`}
    data-conv-row
  >
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      className="flex min-w-0 flex-1 items-center gap-2.5 px-2 text-left text-sm text-slate-700 disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
      ) : (
        <MessageSquare className="h-4 w-4 shrink-0 text-slate-400" />
      )}
      <span className="truncate">{title}</span>
    </button>

    <button
      type="button"
      onClick={onDelete}
      aria-label="删除会话"
      title="删除会话"
      className="mr-1 shrink-0 rounded-md p-1.5 text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  </div>
);

export const AgentPage: React.FC = () => {
  const { username } = useUserStore();
  // 对话状态统一交给 store：流式 token 只更新最后一条助手消息
  const {
    messages,
    isStreaming,
    error,
    send,
    stop,
    reset,
    clearError,
    conversations,
    loadConversations,
    openConversation,
    removeConversation,
    conversationId,
  } = useAgentStore();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasStarted = messages.length > 1 || messages[0]?.id !== "welcome";

  // 进入页面时拉取会话列表
  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  /** 切换会话：先关抽屉（移动端），再拉历史 */
  const handleOpenConversation = async (id: string) => {
    setSidebarOpen(false);
    if (id === conversationId) return;
    setSwitching(id);
    try {
      await openConversation(id);
    } finally {
      setSwitching(null);
    }
  };

  const handleSend = (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || isStreaming) return;

    if (!textOverride) setInput("");
    // 真实后端：SSE 流式返回，逐字渲染
    void send(text);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSend();
  };

  const handleNewChat = () => {
    // 开新会话：清空并重置 conversationId
    reset();
    setInput("");
    setSidebarOpen(false);
    inputRef.current?.focus();
  };

  const handleBackHome = () => {
    navigate("/");
  };

  return (
    <div className="h-[100dvh] w-full bg-[#fafafa] flex overflow-hidden text-slate-900">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[260px] bg-[#f9f9f9] border-r border-slate-200/80 flex flex-col transition-transform duration-300 ease-out md:relative md:inset-auto md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-3 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(false)}
            className="md:hidden h-9 w-9 rounded-lg text-slate-600 hover:bg-slate-200 shrink-0"
            aria-label="关闭侧边栏"
          >
            <X className="w-5 h-5" />
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={handleBackHome}
            className="h-9 rounded-lg text-slate-600 hover:bg-slate-200 hover:text-slate-900 text-xs font-medium gap-1.5 px-2.5"
          >
            <ArrowLeft className="w-4 h-4 shrink-0" />
            <span>返回首页</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={handleNewChat}
            className="ml-auto h-9 rounded-lg border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-medium gap-1.5 px-2.5 shrink-0"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>新聊天</span>
          </Button>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-2">
          {/* 前往笔记模块 */}
          <button
            type="button"
            onClick={() => {
              setSidebarOpen(false);
              navigate("/notes");
            }}
            className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            <NotebookPen className="h-4 w-4 shrink-0 text-indigo-600" />
            <span>笔记</span>
            <ArrowLeft className="ml-auto h-3.5 w-3.5 rotate-180 text-slate-300" />
          </button>

          {/* 历史记录：用虚拟列表承载，列表自身滚动，占满剩余高度 */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              最近
            </div>
            <VirtualList
              count={conversations.length}
              className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent"
              empty={
                <p className="px-2 py-2 text-xs text-slate-400">
                  还没有会话，发一条消息试试
                </p>
              }
              renderRow={(index) => {
                const chat = conversations[index];
                return (
                  <ConversationRow
                    title={chat.title?.trim() || "未命名会话"}
                    active={chat.id === conversationId}
                    busy={switching === chat.id}
                    onOpen={() => void handleOpenConversation(chat.id)}
                    onDelete={() => void removeConversation(chat.id)}
                  />
                );
              }}
            />
          </div>

          <div className="shrink-0">
            <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              工具
            </div>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-200/60"
            >
              <Clock className="h-4 w-4 shrink-0 text-slate-400" />
              <span>历史记录</span>
            </button>
          </div>
        </nav>

        <div className="p-3 border-t border-slate-200/80">
          <div className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-slate-200/60 transition-colors cursor-pointer">
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {username?.[0]?.toUpperCase() ?? "U"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">
                {username || "User"}
              </p>
              <p className="text-[11px] text-slate-500 truncate">免费版</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main */}
      <main className="flex-1 flex flex-col relative min-w-0">
        {/* Mobile menu button */}
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="md:hidden absolute top-3 left-3 z-30 p-2 rounded-lg text-slate-500 hover:bg-slate-200/60 transition-colors"
          aria-label="打开侧边栏"
        >
          <PanelLeft className="w-5 h-5" />
        </button>

        {!hasStarted ? (
          /* Empty state */
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center px-4 py-16">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="w-full max-w-2xl"
            >
              <div className="flex justify-center mb-8">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                  <Sparkles className="w-6 h-6 text-white" />
                </div>
              </div>

              <h1 className="text-center text-2xl sm:text-3xl md:text-4xl font-semibold text-slate-800 mb-8 md:mb-10 tracking-tight px-2">
                我们先从哪里开始呢？
              </h1>

              <InputBar
                floating
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                onStop={stop}
                isStreaming={isStreaming}
                inputRef={inputRef}
              />

            </motion.div>
          </div>
        ) : (
          /* Chat view */
          <>
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 lg:px-8 pt-14 md:pt-6 pb-6 space-y-6 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent"
            >
              <AnimatePresence initial={false}>
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                    className="max-w-3xl mx-auto flex"
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
                        msg.role === "tool"
                          ? "mr-auto bg-amber-50 border border-amber-200/70 text-amber-900 text-xs"
                          : msg.role === "user"
                            ? "ml-auto bg-slate-100 text-slate-800"
                            : "mr-auto bg-white border border-slate-200/80 text-slate-800"
                      }`}
                    >
                      {/* 工具调用：标注状态，提升"它在干什么"的透明度 */}
                      {msg.role === "tool" && (
                        <div className="mb-1 text-[11px] font-medium text-amber-700">
                          {msg.toolStatus === "calling"
                            ? "正在调用工具…"
                            : msg.toolStatus === "failed"
                              ? "工具调用失败"
                              : "工具调用完成"}
                        </div>
                      )}
                      {msg.content}
                      {msg.meta && (
                        <div className="mt-1.5 text-[11px] text-slate-400">
                          {msg.meta}
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {isStreaming && (
                <div className="max-w-3xl mx-auto flex">
                  <div className="mr-auto rounded-2xl px-4 py-3 bg-white border border-slate-200/80 shadow-sm flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: "0ms" }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: "120ms" }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: "240ms" }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="px-4 py-3 md:py-4 bg-gradient-to-t from-[#fafafa] via-[#fafafa] to-transparent">
              {error && (
                <div className="max-w-2xl mx-auto mb-2 flex items-center justify-between gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                  <span className="truncate">{error}</span>
                  <button
                    type="button"
                    onClick={clearError}
                    className="shrink-0 text-red-500 hover:text-red-700"
                  >
                    关闭
                  </button>
                </div>
              )}
              <InputBar
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                onStop={stop}
                isStreaming={isStreaming}
                inputRef={inputRef}
              />
              <p className="text-center text-[10px] text-slate-400 mt-2 px-4">
                Wisora AI 由后端 LangChain Agent 驱动，内容由 AI 生成，请谨慎甄别。
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default AgentPage;
