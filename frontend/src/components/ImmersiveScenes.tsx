import { useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useReducedMotion } from "framer-motion";

gsap.registerPlugin(ScrollTrigger);

/**
 * 首页沉浸式场景：整屏图片逐屏切换
 *
 * 交互模型（与图层叠加式视差不同）：
 *   - 4 张整屏图片，滚动距离 = 3 个视口高（每切换一张消耗约 1.15 视口）
 *   - section 被 ScrollTrigger pin 住，scrub 驱动时间线
 *   - 切换 = 上一张淡出 + 当前张从 1.07 缩放淡入，有"翻页"的纵深感
 *   - 右侧进度指示器随进度点亮；滚动条隐藏后它就是唯一定位依据
 *
 * prefers-reduced-motion：不 pin、不做动画，改为普通纵向排列的四个整屏区块。
 */

interface Scene {
  src: string;
  label: string;
}

const SCENES: Scene[] = [
  { src: "/parallax/scene-1.webp", label: "01 · 晨雾" },
  { src: "/parallax/scene-2.webp", label: "02 · 远山" },
  { src: "/parallax/scene-3.webp", label: "03 · 层峦" },
  { src: "/parallax/scene-4.webp", label: "04 · 暮色" },
];

/** 单个场景的画面内容：整屏图 + 左下角场景编号 */
function SceneFigure({ scene, priority }: { scene: Scene; priority?: boolean }) {
  return (
    <>
      <img
        src={scene.src}
        alt={priority ? scene.label : ""}
        aria-hidden={priority ? undefined : true}
        loading={priority ? "eager" : "lazy"}
        draggable={false}
        className="h-full w-full select-none object-cover"
      />
      <div className="pointer-events-none absolute bottom-16 left-5 sm:left-10">
        <span className="inline-flex items-center rounded-full bg-slate-950/45 px-3 py-1.5 font-mono text-[11px] tracking-[0.18em] text-white/90 backdrop-blur-sm">
          {scene.label}
        </span>
      </div>
    </>
  );
}

export const ImmersiveScenes: React.FC<{
  /** 是否仍处于钉住的场景序列内（用于让固定 CTA 在离开序列后淡出） */
  onImmersiveChange?: (active: boolean) => void;
}> = ({ onImmersiveChange }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();

  // 用 ref 持有回调，避免闭包过期 & 不触发 useGSAP 重跑
  const cbRef = useRef(onImmersiveChange);
  cbRef.current = onImmersiveChange;

  useGSAP(
    () => {
      if (reduce) return;

      const scenes = gsap.utils.toArray<HTMLElement>(
        "[data-scene]",
        rootRef.current ?? undefined,
      );
      if (scenes.length < 2) return;

      // 每切换一张消耗约 1.15 个视口高，4 张图共 3 次切换
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: rootRef.current,
          start: "top top",
          end: () => `+=${Math.round(window.innerHeight * (scenes.length - 1) * 1.15)}`,
          pin: true,
          scrub: 1,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            const idx = Math.min(
              scenes.length - 1,
              Math.round(self.progress * (scenes.length - 1)),
            );
            setActive((prev) => (prev === idx ? prev : idx));
          },
          onToggle: (self) => cbRef.current?.(self.isActive),
        },
      });

      // 后面的场景压在前者之上，淡入 + 从 1.07 缩回 1
      scenes.forEach((scene, i) => {
        if (i === 0) return;
        tl.fromTo(
          scene,
          { autoAlpha: 0, scale: 1.07 },
          { autoAlpha: 1, scale: 1, ease: "none", duration: 1 },
          i - 1,
        );
      });
    },
    { scope: rootRef },
  );

  /* ---- 减弱动效：退化为普通纵向整屏区块，不 pin 不动画 ---- */
  if (reduce) {
    return (
      <div className="no-scrollbar-page">
        {SCENES.map((scene, i) => (
          <section key={scene.src} className="relative h-[100dvh] overflow-hidden bg-slate-950">
            <SceneFigure scene={scene} priority={i === 0} />
          </section>
        ))}
      </div>
    );
  }

  /* ---- 默认：pin + scrub 逐屏切换 ---- */
  return (
    <div ref={rootRef} className="no-scrollbar-page relative">
      <section
        aria-label="首页场景"
        className="relative h-[100dvh] w-full overflow-hidden bg-slate-950"
      >
        {/* 场景层：按序堆叠，时间线控制各自透明度 */}
        {SCENES.map((scene, i) => (
          <div
            key={scene.src}
            data-scene
            className={`absolute inset-0 will-change-transform ${
              i === 0 ? "" : "pointer-events-none invisible opacity-0"
            }`}
          >
            <SceneFigure scene={scene} priority={i === 0} />
          </div>
        ))}

        {/* 右侧进度指示器：滚动条隐藏后的唯一定位依据 */}
        <div
          aria-hidden
          className="pointer-events-none absolute right-4 top-1/2 z-20 -translate-y-1/2 sm:right-7"
        >
          <div className="flex flex-col items-center gap-2.5 rounded-full bg-slate-950/25 p-2 backdrop-blur-sm">
            {SCENES.map((scene, i) => (
              <span
                key={scene.src}
                className={`block rounded-full transition-all duration-300 ${
                  i === active
                    ? "h-5 w-1.5 bg-white"
                    : "h-1.5 w-1.5 bg-white/45"
                }`}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};