import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ImmersiveScenes } from '@/components/ImmersiveScenes';
import { Bot, MessageSquareText } from 'lucide-react';

/**
 * 首页：沉浸式场景（整屏图逐屏切换）+ 能力卡片区
 *
 * - 导航栏透明且 fixed（见 Header transparent 变体）
 * - 滚动条隐藏（见 index.css 的 .no-scrollbar-page 规则）
 * - 「进入 AI 助手」fixed 固定在视口底部，全程可见
 */
const Home: React.FC = () => {
  return (
    <div className="bg-[#f6f5f0]">
      {/* 沉浸式场景：4 张整屏图，滚动逐屏切换 */}
      <ImmersiveScenes />

      {/* 固定 CTA：不随内容滚动，全程悬浮在视口底部 */}
      <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
        <Link
          to="/agent"
          className="group inline-flex items-center gap-2 rounded-full border border-slate-900/10 bg-white/85 px-5 py-3 text-sm font-medium text-slate-900 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.45)] backdrop-blur-xl transition-all hover:bg-white hover:shadow-[0_22px_50px_-12px_rgba(15,23,42,0.55)]"
        >
          <Sparkles className="h-4 w-4 text-indigo-600 transition-transform group-hover:scale-110" />
          进入 AI 助手
          <ArrowRight className="h-4 w-4 text-slate-500 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      {/* 能力卡片：位于场景序列之后 */}
      <section className="px-5 py-20 sm:px-10 sm:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {/* 主卡：AI 助手，占两列 */}
            <Card className="rounded-2xl border-slate-200/80 bg-white shadow-sm transition-shadow hover:shadow-md md:col-span-2">
              <CardHeader className="pb-3">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white">
                  <Bot className="h-5 w-5" />
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
                    <Sparkles className="h-4 w-4" />
                    开始对话
                  </Button>
                </Link>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border-slate-200/80 bg-white shadow-sm transition-shadow hover:shadow-md">
              <CardHeader className="pb-3">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                  <MessageSquareText className="h-5 w-5" />
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
                    className="w-full rounded-xl border-slate-200 text-sm"
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