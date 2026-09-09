import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useReducedMotion } from "framer-motion";

gsap.registerPlugin(ScrollTrigger);

/**
 * 首页视差背景容器（晨雾层峦 · 4 层景深）
 *
 * 4 层背景在同一时间线上联动，由单个 ScrollTrigger scrub 驱动：
 *   - sky   ：几乎不动（最深）
 *   - far   ：缓慢上移
 *   - mid   ：中等速度
 *   - near  ：最快上移（最近）
 * 加上顶部暗角（保证透明导航栏文字对比）和底部地雾（遮住生成图水印 + 加氛围）。
 *
 * 层 2/3/4 都用 mix-blend-mode: multiply，白底变透明只留山的剪影，
 * 山的暗色与天空相乘产生真实的空气透视。
 *
 * 尊重 prefers-reduced-motion：减弱运动时直接渲染静态画面，不跑时间线。
 */
export const ParallaxHero: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => {
  const sectionRef = useRef<HTMLElement>(null);
  const layer1Ref = useRef<HTMLDivElement>(null);
  const layer2Ref = useRef<HTMLDivElement>(null);
  const layer3Ref = useRef<HTMLDivElement>(null);
  const layer4Ref = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useGSAP(
    () => {
      if (reduce) return;

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "bottom top",
          scrub: 1,
          invalidateOnRefresh: true,
        },
      });

      // 联动：同一个时间线、ease:none，每层只动 yPercent 不同时机。
      // 景深越深 → 移动越少；越近 → 移动越多。
      tl.to(layer1Ref.current, { yPercent: -8, ease: "none" }, 0);
      tl.to(layer2Ref.current, { yPercent: -15, ease: "none" }, 0);
      tl.to(layer3Ref.current, { yPercent: -30, ease: "none" }, 0);
      tl.to(layer4Ref.current, { yPercent: -55, ease: "none" }, 0);
      tl.to(scrimRef.current, { opacity: 0.85, ease: "none" }, 0);

      // 前景文字随滚动轻轻上移并淡出，腾位给下方章节
      tl.to(
        contentRef.current,
        { yPercent: -20, opacity: 0.15, ease: "none" },
        0,
      );
    },
    { scope: sectionRef },
  );

  return (
    <section
      ref={sectionRef}
      className="relative h-[100dvh] min-h-[640px] w-full overflow-hidden bg-[#f6f5f0]"
      aria-label="首页视差背景"
    >
      {/* 第 1 层：天空。最深、最慢。h 比视口多以容纳上移。 */}
      <div
        ref={layer1Ref}
        className="absolute inset-x-0 -top-[12%] h-[124%] will-change-transform"
      >
        <img
          src="/parallax/layer-1-sky.png"
          alt=""
          aria-hidden
          className="w-full h-full object-cover"
        />
      </div>

      {/* 第 2 层：远山。白底 × multiply 变透明，只留淡蓝山影。 */}
      <div
        ref={layer2Ref}
        className="absolute inset-x-0 -top-[12%] h-[124%] mix-blend-multiply will-change-transform"
      >
        <img
          src="/parallax/layer-2-far.png"
          alt=""
          aria-hidden
          className="w-full h-full object-cover object-bottom"
        />
      </div>

      {/* 第 3 层：中景山脊。 */}
      <div
        ref={layer3Ref}
        className="absolute inset-x-0 -top-[12%] h-[140%] mix-blend-multiply will-change-transform"
      >
        <img
          src="/parallax/layer-3-mid.png"
          alt=""
          aria-hidden
          className="w-full h-full object-cover object-bottom"
        />
      </div>

      {/* 第 4 层：近景剪影。最快、最暗。 */}
      <div
        ref={layer4Ref}
        className="absolute inset-x-0 -top-[12%] h-[160%] mix-blend-multiply will-change-transform"
      >
        <img
          src="/parallax/layer-4-near.png"
          alt=""
          aria-hidden
          className="w-full h-full object-cover object-bottom"
        />
      </div>

      {/* 顶部暗角：保证透明导航栏文字可读，仅首屏顶 8rem。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-32 bg-gradient-to-b from-slate-950/55 to-transparent"
      />

      {/* 底部地雾：随滚动加深，盖住生成图水印 + 营造山脚雾气。 */}
      <div
        ref={scrimRef}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-48 bg-gradient-to-t from-slate-950/70 via-slate-900/35 to-transparent"
      />

      {/* 前景内容（左对齐，不挡右侧景观）。 */}
      <div
        ref={contentRef}
        className="relative z-[3] flex h-full items-center px-5 sm:px-10 will-change-transform"
      >
        <div className="w-full max-w-xl">{children}</div>
      </div>
    </section>
  );
};