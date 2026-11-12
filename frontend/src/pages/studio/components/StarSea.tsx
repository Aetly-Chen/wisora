import React, { useEffect, useRef } from 'react';

/**
 * 空库的「知识海」：粒子缓慢漂移 + 近距连线 + 点击涟漪。
 *
 * 纯 canvas，不引任何库。近距连线是 O(n²)，粒子控制在 180 以内 ——
 * 一屏 60fps 跑满在集显上也就 3ms 左右，比 3D 力导向（three.js）轻得多。
 * 以后想要真正的 3D 星空，可以换 `vasturiano/3d-force-graph`。
 */
export const StarSea: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    type Star = { x: number; y: number; vx: number; vy: number; r: number };
    let stars: Star[] = [];
    const ripples: Array<{ x: number; y: number; r: number; life: number }> = [];

    const seed = () => {
      stars = Array.from({ length: 180 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.14,
        vy: (Math.random() - 0.5) * 0.14,
        r: Math.random() * 1.4 + 0.5,
      }));
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const loop = () => {
      ctx.clearRect(0, 0, w, h);

      for (const s of stars) {
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < 0 || s.x > w) s.vx *= -1;
        if (s.y < 0 || s.y > h) s.vy *= -1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = '#8c857a';
        ctx.globalAlpha = 0.7;
        ctx.fill();
      }

      /* 近距连线：这张网就是「笔记会连起来」的隐喻 */
      ctx.globalAlpha = 1;
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const a = stars[i];
          const b = stars[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 108) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = '#8c857a';
            ctx.globalAlpha = (1 - d / 108) * 0.16;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }

      for (let k = ripples.length - 1; k >= 0; k--) {
        const r = ripples[k];
        r.life -= 0.012;
        r.r += 2.6;
        if (r.life <= 0) {
          ripples.splice(k, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#8a5a2b';
        ctx.globalAlpha = r.life * 0.5;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(loop);
    };

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      ripples.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, r: 4, life: 1 });
    };

    resize();
    raf = requestAnimationFrame(loop);
    canvas.addEventListener('click', onClick);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('click', onClick);
    };
  }, []);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden />;
};

export default StarSea;
