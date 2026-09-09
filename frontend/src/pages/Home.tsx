import React from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ParallaxHero } from '@/components/ParallaxHero';
import { Bot, MessageSquareText, Sparkles, ArrowRight } from 'lucide-react';

/**
 * 首页：视差 Hero + 能力卡片区
 *
 * 设计读法：
 *   SaaS / 工具型首页，技术向用户。左对齐（非居中）规避 AI 模板感。
 *   透明导航栏叠在视差天空上，frosted glass 内容卡保证文字对比度。
 */

const Home: React.FC = () => {
  const reduce = useReducedMotion();
  const heroEntrance = {
    initial: reduce ? false : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const, delay: 0.1 },
  };

  return (
    <div className="bg-[#f6f5f0]">
      {/* 视差 Hero：四层联动背景，左对齐内容卡 */}
      <ParallaxHero>
        <motion.div
          {...heroEntrance}
          className="rounded-3xl border border-white/60 bg-white/80 backdrop-blur-xl p-6 sm:p-8 shadow-[0_30px_80px_-20px_rgba(15,23,42,0.25)]"
        >
          {/* 1. eyebrow */}
          <div className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-indigo-700 mb-4">
            Wisora · AI Workbench
          </div>

          {/* 2. headline */}
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold text-slate-900 tracking-tight leading-[1.1]">
            AI 驱动的
            <br />
            智能工作台
          </h1>

          {/* 3. subtext */}
          <p className="mt-4 text-sm sm:text-base text-slate-600 leading-relaxed max-w-[44ch]">
            流式对话与知识协作，多端实时同步。
          </p>

          {/* 4. CTA */}
          <div className="mt-7 flex items-center gap-3">
            <Link to="/agent">
              <Button variant="brand" className="rounded-xl text-sm px-5">
                <Sparkles className="w-4 h-4" />
                进入 AI 助手
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Link to="/about">
              <Button
                variant="ghost"
                className="rounded-xl text-sm text-slate-700 hover:bg-slate-100 px-4"
              >
                了解更多
              </Button>
            </Link>
          </div>
        </motion.div>
      </ParallaxHero>

      {/* 能力卡片：位于视差 Hero 之下，温暖米白底 */}
      <section className="px-5 sm:px-10 py-20 sm:py-24">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* 主卡：AI 助手，占两列 */}
            <Card className="md:col-span-2 rounded-2xl border-slate-200/80 bg-white shadow-sm hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white mb-4">
                  <Bot className="w-5 h-5" />
                </div>
                <CardTitle className="text-lg">Wisora AI Assistant</CardTitle>
                <CardDescription className="text-sm">
                  基于 LangChain Agent 的流式对话、文档总结与数据分析，
                  支持工具调用与多轮上下文记忆。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link to="/agent">
                  <Button variant="brand" className="rounded-xl text-sm">
                    <Sparkles className="w-4 h-4" />
                    开始对话
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border-slate-200/80 bg-white shadow-sm hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center text-slate-700 mb-4">
                  <MessageSquareText className="w-5 h-5" />
                </div>
                <CardTitle className="text-lg">关于 Wisora</CardTitle>
                <CardDescription className="text-sm">
                  产品定位、技术栈与后续路线。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link to="/about">
                  <Button
                    variant="outline"
                    className="rounded-xl text-sm w-full border-slate-200"
                  >
                    查看详情
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;