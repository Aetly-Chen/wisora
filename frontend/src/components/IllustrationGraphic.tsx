import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, Cpu, Database, BarChart3, Activity, Zap, CheckCircle2, Bot } from 'lucide-react';

export const IllustrationGraphic: React.FC = () => {
  const [activeNode, setActiveNode] = useState<string>('ai');

  return (
    <div className="relative w-full h-full min-h-[380px] lg:min-h-[460px] bg-gradient-to-br from-indigo-50/90 via-purple-50/60 to-slate-100/90 rounded-2xl md:rounded-3xl p-6 lg:p-8 flex flex-col justify-between overflow-hidden border border-indigo-100/60 shadow-inner select-none">
      {/* Background Decorative Grid */}
      <div 
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(#3b42c4 1px, transparent 1px)`,
          backgroundSize: '20px 20px'
        }}
      />

      {/* Floating Header Tag */}
      <div className="relative z-10 flex items-center justify-between">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/80 backdrop-blur-sm border border-indigo-100 shadow-xs">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="text-xs font-semibold text-indigo-950">Wisora AI 矩阵引擎 v3.5</span>
        </div>

        <div className="flex items-center gap-1.5 bg-indigo-600/10 text-indigo-700 text-xs px-2.5 py-1 rounded-full font-medium">
          <Zap className="w-3.5 h-3.5 text-indigo-600 fill-indigo-600" />
          <span>99.9% 运行状态</span>
        </div>
      </div>

      {/* Main Isometric AI Network Diagram */}
      <div className="relative z-10 my-auto py-4 flex items-center justify-center">
        <div className="relative w-full max-w-[340px] aspect-square flex items-center justify-center">
          
          {/* Connecting Circuit Lines SVG */}
          <svg className="absolute inset-0 w-full h-full text-indigo-300/60" viewBox="0 0 300 300" fill="none">
            <motion.path
              d="M 60 100 L 150 150 L 240 100"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="4 4"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1.5, repeat: Infinity, repeatType: "reverse" }}
            />
            <motion.path
              d="M 60 200 L 150 150 L 240 200"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="4 4"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 2, repeat: Infinity, repeatType: "reverse" }}
            />
            <line x1="150" y1="80" x2="150" y2="150" stroke="currentColor" strokeWidth="2" />
            <line x1="150" y1="150" x2="150" y2="230" stroke="currentColor" strokeWidth="2" />
          </svg>

          {/* Top Floating Card: Analytics */}
          <motion.div 
            whileHover={{ scale: 1.05, y: -4 }}
            onClick={() => setActiveNode('chart')}
            className={`absolute top-2 left-2 cursor-pointer p-3 rounded-2xl bg-white/90 backdrop-blur-md border shadow-lg transition-all ${
              activeNode === 'chart' ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-100'
            }`}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <div className="p-1.5 rounded-lg bg-indigo-100 text-indigo-600">
                <BarChart3 className="w-4 h-4" />
              </div>
              <span className="text-xs font-bold text-slate-800">实时推理分析</span>
            </div>
            <div className="flex items-end gap-1 h-8 w-28 pt-1">
              <span className="w-3 bg-indigo-300 rounded-t h-[40%]" />
              <span className="w-3 bg-indigo-400 rounded-t h-[70%]" />
              <span className="w-3 bg-indigo-600 rounded-t h-[100%]" />
              <span className="w-3 bg-indigo-500 rounded-t h-[60%]" />
              <span className="w-3 bg-indigo-400 rounded-t h-[85%]" />
            </div>
          </motion.div>

          {/* Top Right Floating Card: Workflow Node */}
          <motion.div 
            whileHover={{ scale: 1.05, y: -4 }}
            onClick={() => setActiveNode('workflow')}
            className={`absolute top-2 right-2 cursor-pointer p-3 rounded-2xl bg-white/90 backdrop-blur-md border shadow-lg transition-all ${
              activeNode === 'workflow' ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-100'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-purple-100 text-purple-600">
                <Cpu className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-800">智能体编排</div>
                <div className="text-[10px] text-slate-500">多模态 Agent 工作流</div>
              </div>
            </div>
          </motion.div>

          {/* Center Glowing Hub: AI Brain Speech Bubble */}
          <motion.div 
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            onClick={() => setActiveNode('ai')}
            className="relative cursor-pointer z-20 flex flex-col items-center justify-center w-28 h-28 rounded-3xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-purple-600 text-white shadow-2xl shadow-indigo-500/40 p-4 border-2 border-white/60"
          >
            <div className="relative">
              <div className="p-2.5 rounded-2xl bg-white/20 backdrop-blur-md mb-1">
                <Bot className="w-8 h-8 text-white" />
              </div>
              <Sparkles className="w-4 h-4 text-amber-300 absolute -top-1 -right-1 animate-pulse" />
            </div>
            <span className="text-xs font-bold tracking-wide mt-0.5">Wisora AI</span>
          </motion.div>

          {/* Bottom Left Floating Card: Database Stack */}
          <motion.div 
            whileHover={{ scale: 1.05, y: 4 }}
            onClick={() => setActiveNode('db')}
            className={`absolute bottom-2 left-2 cursor-pointer p-3 rounded-2xl bg-white/90 backdrop-blur-md border shadow-lg transition-all ${
              activeNode === 'db' ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-100'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-blue-100 text-blue-600">
                <Database className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-800">向量知识库</div>
                <div className="text-[10px] text-slate-500">高维检索 & 级联缓存</div>
              </div>
            </div>
          </motion.div>

          {/* Bottom Right Floating Card: Activity Metric */}
          <motion.div 
            whileHover={{ scale: 1.05, y: 4 }}
            onClick={() => setActiveNode('speed')}
            className={`absolute bottom-2 right-2 cursor-pointer p-3 rounded-2xl bg-white/90 backdrop-blur-md border shadow-lg transition-all ${
              activeNode === 'speed' ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-100'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-emerald-100 text-emerald-600">
                <Activity className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-800">极致并行速度</div>
                <div className="text-[10px] text-emerald-600 font-medium">120 Tokens / 秒</div>
              </div>
            </div>
          </motion.div>

        </div>
      </div>

      {/* Dynamic Feature Subtitle Bar */}
      <div className="relative z-10 pt-2 border-t border-indigo-100/80 flex items-center justify-between text-xs text-slate-600">
        <div className="flex items-center gap-1.5 font-medium text-indigo-950">
          <CheckCircle2 className="w-4 h-4 text-indigo-600" />
          <span>全场景适配：Web 大屏 + H5 移动端无缝联动</span>
        </div>
        <div className="hidden sm:block text-[11px] text-slate-600">
          轻量 · 极速 · 智能
        </div>
      </div>
    </div>
  );
};
