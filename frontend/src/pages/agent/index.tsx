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
  Image as ImageIcon,
  Pencil,
  Globe,
  X,
  MessageSquare,
  Clock,
  Sparkles,
  PanelLeft,
  Lightbulb,
  ArrowLeft,
  Trash2,
  Loader2,
} from "lucide-react";

interface ActionCard {
  id: string;
  label: string;
  iconName: "ImageIcon" | "Pencil" | "Globe";
}

const actionCards: ActionCard[] = [
  { id: "image", label: "创建图像或贴纸", iconName: "ImageIcon" },
  { id: "write", label: "撰写或编辑", iconName: "Pencil" },
  { id: "search", label: "搜索网页", iconName: "Globe" },
];

const iconMap: Record<ActionCard["iconName"], React.ElementType> = {
  ImageIcon,
  Pencil,
  Globe,
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

  const handleCardClick = (card: ActionCard) => {
    const prompts: Record<string, string> = {
      image: "帮我创建一张与 Wisora 品牌风格一致的图像或贴纸。",
      write: "帮我撰写一段关于 Wisora AI 工作台的介绍文案。",
      search: "搜索 Wisora AI 工作台的最新功能和更新。",
    };
    handleSend(prompts[card.id]);
    inputRef.current?.focus();
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

        <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-4">
          <div>
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-2 mb-1.5">
              最近
            </div>
            <div className="space-y-0.5">
              {conversations.length === 0 ? (
                <p className="px-2 py-2 text-xs text-slate-400">
                  还没有会话，发一条消息试试
                </p>
              ) : (
                conversations.map((chat) => {
                  const active = chat.id === conversationId;
                  const busy = switching === chat.id;
                  return (
                    <div
                      key={chat.id}
                      className={`group relative flex items-center rounded-lg transition-colors ${
                        active ? "bg-slate-200/70" : "hover:bg-slate-200/60"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void handleOpenConversation(chat.id)}
                        disabled={busy}
                        className="flex-1 min-w-0 flex items-center gap-2.5 px-2 py-2 text-sm text-slate-700 text-left disabled:opacity-60"
                      >
                        {busy ? (
                          <Loader2 className="w-4 h-4 text-slate-400 shrink-0 animate-spin" />
                        ) : (
                          <MessageSquare className="w-4 h-4 text-slate-400 shrink-0" />
                        )}
                        <span className="truncate">
                          {chat.title?.trim() || "未命名会话"}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void removeConversation(chat.id)}
                        aria-label="删除会话"
                        title="删除会话"
                        className="shrink-0 mr-1 p-1.5 rounded-md text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-2 mb-1.5">
              工具
            </div>
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-200/60 transition-colors text-left"
              >
                <ImageIcon className="w-4 h-4 text-slate-400 shrink-0" />
                <span>图片</span>
              </button>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-200/60 transition-colors text-left"
              >
                <Globe className="w-4 h-4 text-slate-400 shrink-0" />
                <span>搜索网页</span>
              </button>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-200/60 transition-colors text-left"
              >
                <Clock className="w-4 h-4 text-slate-400 shrink-0" />
                <span>历史记录</span>
              </button>
            </div>
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

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-4">
                {actionCards.map((card) => {
                  const Icon = iconMap[card.iconName];
                  return (
                    <motion.button
                      key={card.id}
                      type="button"
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => handleCardClick(card)}
                      disabled={isStreaming}
                      className="flex items-center gap-2.5 px-3.5 py-3 rounded-2xl bg-white border border-slate-200/80 text-left text-sm text-slate-700 hover:shadow-md hover:border-slate-300 transition-all disabled:opacity-50"
                    >
                      <Icon className="w-4 h-4 text-slate-500 shrink-0" />
                      <span className="truncate">{card.label}</span>
                    </motion.button>
                  );
                })}
              </div>
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
