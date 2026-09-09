import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { subscribeLoading } from "@/request/loading";
import { subscribeRequestError, clearRequestError } from "@/request/error";

/**
 * 请求超过这个时长才显示遮罩。
 *
 * 目的是消除闪烁：
 * 一个 80ms 返回的接口，如果遮罩立刻挂载再立刻卸载，
 * 用户看到的就是一次白闪。
 */
const SHOW_DELAY = 300;

/**
 * 遮罩一旦显示，至少停留这么久。
 *
 * 防止“刚显示就结束”造成的二次闪烁。
 */
const MIN_DURATION = 400;

/**
 * 把「是否忙碌」转换成「是否显示遮罩」。
 *
 * 规则：
 * - 忙碌持续超过 SHOW_DELAY 才显示
 * - 显示后至少停留 MIN_DURATION
 * - 如果在 SHOW_DELAY 内就结束了，全程不显示
 */
function useDelayedFlag(
  active: boolean,
  showDelay: number,
  minDuration: number,
) {
  const [visible, setVisible] = React.useState(false);
  const stateRef = React.useRef({ shownAt: 0, visible: false });

  React.useEffect(() => {
    const timers: number[] = [];

    if (active) {
      timers.push(
        window.setTimeout(() => {
          stateRef.current = { shownAt: Date.now(), visible: true };
          setVisible(true);
        }, showDelay),
      );
    } else if (stateRef.current.visible) {
      const elapsed = Date.now() - stateRef.current.shownAt;
      const remaining = Math.max(0, minDuration - elapsed);

      if (remaining > 0) {
        timers.push(
          window.setTimeout(() => {
            stateRef.current = { shownAt: 0, visible: false };
            setVisible(false);
          }, remaining),
        );
      } else {
        stateRef.current = { shownAt: 0, visible: false };
        setVisible(false);
      }
    }

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [active, showDelay, minDuration]);

  return visible;
}

/**
 * 全局请求反馈。
 *
 * 负责两件事：
 * 1. 请求进行中 → 居中 Loading 卡片（shadcn Card）
 * 2. 请求出错   → shadcn / sonner Toast
 */
export const RequestFeedback: React.FC = () => {
  const [loadingCount, setLoadingCount] = React.useState(0);
  const lastErrorRef = React.useRef<string | null>(null);

  React.useEffect(() => subscribeLoading(setLoadingCount), []);

  React.useEffect(
    () =>
      subscribeRequestError((message) => {
        /**
         * 同一个 tick 内重复的错误只弹一次，避免重试导致 toast 刷屏。
         */
        if (message && message !== lastErrorRef.current) {
          toast.error(message, { duration: 4000 });

          /**
           * 弹完立刻复位 error 模块的当前消息。
           *
           * 不复位的话，下次出现「内容相同」的错误时，
           * currentError 没有变化，去重逻辑会把它吞掉。
           *
           * 用微任务延后一拍，避免在 listeners 遍历过程中重入 emit。
           */
          queueMicrotask(() => clearRequestError());
        }

        lastErrorRef.current = message;
      }),
    [],
  );

  const showOverlay = useDelayedFlag(
    loadingCount > 0,
    SHOW_DELAY,
    MIN_DURATION,
  );

  return (
    <AnimatePresence>
      {showOverlay && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-slate-900/10 backdrop-blur-[2px]"
        >
          <Card className="flex items-center gap-3 rounded-2xl border-slate-200/90 bg-white/95 px-5 py-4 shadow-2xl">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
            <span className="text-sm font-medium text-slate-700">
              请求处理中…
            </span>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
