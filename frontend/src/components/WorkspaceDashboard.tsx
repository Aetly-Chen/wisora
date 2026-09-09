import React, { useState } from 'react';
import { motion } from 'framer-motion';
import type { UserProfile } from '../types/auth';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import {
  LogOut,
  Bot,
  Send,
  Zap,
  Layers,
  BarChart3,
  User,
  Cpu,
  CheckCircle2,
  Copy,
  Plus,
  Sliders,
  Laptop
} from 'lucide-react';

interface WorkspaceDashboardProps {
  user: UserProfile;
  onLogout: () => void;
  onShowToast: (msg: string) => void;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  time: string;
}

export const WorkspaceDashboard: React.FC<WorkspaceDashboardProps> = ({
  user,
  onLogout,
  onShowToast,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'workflow' | 'analytics' | 'profile'>('chat');
  
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      sender: 'ai',
      text: `你好，${user.name}！我是 Wisora AI 智能助手。我已经就绪，随时可以为你生成代码、分析数据、构建 Workflow 智能体或执行自动化任务。`,
      time: '10:00',
    },
  ]);
  const [inputMsg, setInputMsg] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // Workflow demo state
  const [workflowNodes, setWorkflowNodes] = useState([
    { id: '1', name: '用户输入触发器', type: 'Trigger', status: '正常运行' },
    { id: '2', name: 'Vector RAG 向量检索', type: 'Knowledge', status: '运行中' },
    { id: '3', name: 'Gemini 2.5 Flash 推理', type: 'Model', status: '已连接' },
    { id: '4', name: '多端 H5 & Web 协同渲染', type: 'Output', status: '就绪' },
  ]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMsg.trim()) return;

    const userText = inputMsg;
    const newMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: userText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, newMsg]);
    setInputMsg('');
    setIsTyping(true);

    // Simulate AI response
    setTimeout(() => {
      let replyText = `收到你的请求："${userText}"。Wisora 智能模型已通过全双工节点完成处理，包含最佳算法匹配与格式化输出。`;
      if (userText.includes('代码') || userText.includes('React')) {
        replyText = `已为你生成符合 React + TypeScript + TailwindCSS 标准的代码范例。已同步至前端多端渲染管道！`;
      } else if (userText.includes('你好') || userText.includes('hi')) {
        replyText = `你好！很高兴在 Wisora 智能控制台见到你。有什么我可以帮你的吗？`;
      }

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: replyText,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setIsTyping(false);
    }, 1000);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    onShowToast('文本已复制到剪贴板');
  };

  const handleAddNode = () => {
    const newNode = {
      id: Date.now().toString(),
      name: `自定义 AI 扩展节点 #${workflowNodes.length + 1}`,
      type: 'Agent Node',
      status: '就绪',
    };
    setWorkflowNodes([...workflowNodes, newNode]);
    onShowToast('成功添加新工作流节点！');
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-2 sm:px-4 py-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="rounded-3xl border border-slate-200/90 bg-white/95 backdrop-blur-xl shadow-2xl overflow-hidden"
      >
        {/* Top Workspace Header */}
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-4 sm:p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src={user.avatar}
              alt={user.name}
              className="w-12 h-12 rounded-2xl ring-2 ring-indigo-400/50 object-cover"
            />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg sm:text-xl font-bold">{user.name}</h2>
                <Badge variant="default" className="bg-indigo-500/30 text-indigo-200 border-indigo-400/30 text-[10px]">
                  {user.role}
                </Badge>
              </div>
              <p className="text-xs text-slate-300 mt-0.5">{user.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="bg-white/10 backdrop-blur-md px-3 py-1.5 rounded-xl border border-white/10 text-xs">
              <span className="text-slate-300">可用 Token: </span>
              <span className="font-bold text-amber-300 ml-1">{user.tokenBalance.toLocaleString()}</span>
            </div>

            <Button
              variant="destructive"
              size="sm"
              onClick={onLogout}
              className="rounded-xl text-xs gap-1.5 bg-red-600/80 hover:bg-red-600"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>退出登录</span>
            </Button>
          </div>
        </div>

        {/* Dashboard Navigation Tabs */}
        <div className="border-b border-slate-200 bg-slate-50/80 px-4 pt-2 flex items-center justify-between overflow-x-auto scrollbar-none">
          <div className="flex items-center gap-1 sm:gap-2">
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex items-center gap-2 px-4 py-3 border-b-2 text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'chat'
                  ? 'border-indigo-600 text-indigo-600 bg-white rounded-t-xl'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <Bot className="w-4 h-4" />
              <span>AI 智能助手</span>
            </button>

            <button
              onClick={() => setActiveTab('workflow')}
              className={`flex items-center gap-2 px-4 py-3 border-b-2 text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'workflow'
                  ? 'border-indigo-600 text-indigo-600 bg-white rounded-t-xl'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-4 h-4" />
              <span>智能体工作流</span>
            </button>

            <button
              onClick={() => setActiveTab('analytics')}
              className={`flex items-center gap-2 px-4 py-3 border-b-2 text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'analytics'
                  ? 'border-indigo-600 text-indigo-600 bg-white rounded-t-xl'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <BarChart3 className="w-4 h-4" />
              <span>性能与分析</span>
            </button>

            <button
              onClick={() => setActiveTab('profile')}
              className={`flex items-center gap-2 px-4 py-3 border-b-2 text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'profile'
                  ? 'border-indigo-600 text-indigo-600 bg-white rounded-t-xl'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <User className="w-4 h-4" />
              <span>账号安全管理</span>
            </button>
          </div>

          <div className="hidden md:flex items-center gap-2 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Wisora Core Engine Online</span>
          </div>
        </div>

        {/* Tab Contents */}
        <div className="p-4 sm:p-6 min-h-[420px]">
          
          {/* TAB 1: AI Chat Assistant */}
          {activeTab === 'chat' && (
            <div className="flex flex-col h-[460px] justify-between">
              {/* Messages Container */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-2.5 ${
                      msg.sender === 'user' ? 'flex-row-reverse' : 'flex-row'
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        msg.sender === 'user'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gradient-to-tr from-indigo-500 to-purple-600 text-white shadow-sm'
                      }`}
                    >
                      {msg.sender === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                    </div>

                    <div
                      className={`max-w-[80%] rounded-2xl p-3.5 text-xs sm:text-sm leading-relaxed ${
                        msg.sender === 'user'
                          ? 'bg-indigo-600 text-white rounded-tr-none'
                          : 'bg-slate-100 text-slate-800 rounded-tl-none border border-slate-200/60'
                      }`}
                    >
                      <p>{msg.text}</p>
                      <div
                        className={`flex items-center justify-end gap-1 mt-1 text-[10px] ${
                          msg.sender === 'user' ? 'text-indigo-200' : 'text-slate-400'
                        }`}
                      >
                        <span>{msg.time}</span>
                        {msg.sender === 'ai' && (
                          <button
                            onClick={() => handleCopy(msg.text)}
                            className="p-1 hover:text-slate-600 ml-1"
                            title="复制回复"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {isTyping && (
                  <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                    <Bot className="w-4 h-4 text-indigo-600 animate-bounce" />
                    <span>Wisora AI 正在思考并生成回复...</span>
                  </div>
                )}
              </div>

              {/* Chat Input Bar */}
              <form onSubmit={handleSendMessage} className="pt-3 border-t border-slate-200 flex gap-2">
                <Input
                  type="text"
                  placeholder="给 Wisora AI 发送消息 (如：生成代码、构建 Workflow 或解答问题)..."
                  value={inputMsg}
                  onChange={(e) => setInputMsg(e.target.value)}
                  className="bg-slate-50 border-slate-200"
                />
                <Button type="submit" variant="brand" className="rounded-xl px-5">
                  <Send className="w-4 h-4" />
                </Button>
              </form>
            </div>
          )}

          {/* TAB 2: Workflow & Agents */}
          {activeTab === 'workflow' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-900">Wisora 智能体工作流引擎</h3>
                  <p className="text-xs text-slate-500">串联大模型、数据库与多端 H5/Web 节点</p>
                </div>

                <Button onClick={handleAddNode} variant="outline" size="sm" className="rounded-xl gap-1 text-xs">
                  <Plus className="w-3.5 h-3.5" />
                  <span>新增节点</span>
                </Button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                {workflowNodes.map((node, index) => (
                  <div
                    key={node.id}
                    className="p-4 rounded-2xl border border-slate-200 bg-slate-50/60 hover:bg-white hover:shadow-md transition-all relative group"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                        Node 0{index + 1}
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-emerald-600 font-medium">
                        <CheckCircle2 className="w-3 h-3" />
                        {node.status}
                      </span>
                    </div>

                    <h4 className="text-sm font-bold text-slate-900 mb-1">{node.name}</h4>
                    <p className="text-xs text-slate-500 mb-3">{node.type}</p>

                    <div className="pt-2 border-t border-slate-200/60 flex items-center justify-between text-[11px] text-slate-400">
                      <span>延迟: 12ms</span>
                      <Sliders className="w-3.5 h-3.5 text-slate-400 hover:text-indigo-600 cursor-pointer" />
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-4 rounded-2xl bg-indigo-50/80 border border-indigo-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-indigo-600 text-white">
                    <Zap className="w-5 h-5" />
                  </div>
                  <div>
                    <h5 className="text-xs font-bold text-indigo-950">多端同步就绪 (Web & H5)</h5>
                    <p className="text-[11px] text-indigo-700">工作流可在 iOS Safari、Android 微信及 PC 桌面端同步高并发执行</p>
                  </div>
                </div>
                <Button size="sm" variant="brand" className="rounded-xl text-xs" onClick={() => onShowToast('正在更新全端调度引擎配置...')}>
                  立即部署
                </Button>
              </div>
            </div>
          )}

          {/* TAB 3: Performance & Analytics */}
          {activeTab === 'analytics' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>接口响应平均延迟</span>
                    <Cpu className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="text-2xl font-black text-slate-900">18.4 ms</div>
                  <div className="text-[10px] text-emerald-600 font-medium mt-1">↑ 相比昨日优化 12%</div>
                </div>

                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>并发 Token 吞吐量</span>
                    <Zap className="w-4 h-4 text-amber-500" />
                  </div>
                  <div className="text-2xl font-black text-slate-900">1,280 /s</div>
                  <div className="text-[10px] text-slate-500 font-medium mt-1">多核 GPU 集群加速</div>
                </div>

                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>请求成功率</span>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="text-2xl font-black text-slate-900">99.98 %</div>
                  <div className="text-[10px] text-emerald-600 font-medium mt-1">无服务中断日志</div>
                </div>
              </div>

              {/* Chart Graphic Preview */}
              <div className="p-4 rounded-2xl border border-slate-200 bg-white">
                <h4 className="text-xs font-bold text-slate-800 mb-3">近 24 小时 AI API 调用量分布 (次/分钟)</h4>
                <div className="h-40 flex items-end justify-between gap-1 sm:gap-2 pt-4 px-2 bg-slate-50 rounded-xl border border-slate-100">
                  {[40, 65, 30, 85, 95, 70, 60, 100, 80, 55, 90, 75, 88, 62, 98, 70].map((val, idx) => (
                    <div key={idx} className="flex-1 flex flex-col items-center gap-1 group">
                      <div
                        style={{ height: `${val}%` }}
                        className="w-full bg-indigo-500 rounded-t group-hover:bg-indigo-600 transition-colors"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Profile & Safety */}
          {activeTab === 'profile' && (
            <div className="space-y-4 max-w-2xl mx-auto py-2">
              <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50 space-y-3">
                <h4 className="text-sm font-bold text-slate-900">个人账号与登录会话</h4>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-500">用户 ID</span>
                    <span className="font-mono text-slate-800">{user.id}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-500">安全邮箱</span>
                    <span className="font-medium text-slate-800">{user.email}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-500">当前活跃设备</span>
                    <span className="font-medium text-emerald-600 flex items-center gap-1">
                      <Laptop className="w-3.5 h-3.5" /> Web 桌面端 / H5 移动端
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-2xl border border-indigo-100 bg-indigo-50/50 flex items-center justify-between">
                <div>
                  <h5 className="text-xs font-bold text-indigo-950">重置登录密码</h5>
                  <p className="text-[11px] text-indigo-700">保障你的账号在 Web 和移动端安全</p>
                </div>
                <Button size="sm" variant="outline" className="rounded-xl text-xs border-indigo-200" onClick={() => onShowToast('已向绑定邮箱发送密码重置链接')}>
                  发送重置邮件
                </Button>
              </div>
            </div>
          )}

        </div>
      </motion.div>
    </div>
  );
};
