/**
 * 笔记里的图片：Markdown 存稳定引用，渲染时换成短时直链。
 *
 * ## 为什么不能直接存 URL
 *
 * 后端 `/attachments/:id/content` 挂了 JwtAuthGuard，而 `<img src>` 是浏览器
 * 原生的资源加载，**带不上 Authorization 头**，直接引用必然 401。
 * 后端因此提供了签名直链（`/attachments/:id/raw?exp=&sig=`），
 * 但它有有效期 —— 存进 Markdown 里就等于埋了一颗定时炸弹：
 * 一小时后整篇笔记的图全裂。
 *
 * 所以正文里存 `attachment:<id>`（永久有效、与存储位置无关），
 * 渲染时再换成本次会话签出来的 URL。
 *
 * ## 同一套逻辑服务三处
 *
 * 预览区（marked 渲染的 HTML）、编辑区（ProseMirror 的 image NodeView）、
 * 以及将来的导出，都走这里 —— 避免三处各写一份签名缓存。
 */
import { signAttachments } from '@/request/notes';

const BASE = import.meta.env.VITE_BASE_API ?? '';

/** 正文里的引用前缀。改它等于改数据格式，别动。 */
export const ATTACHMENT_SCHEME = 'attachment:';

/** 后端签发的 TTL 是 1 小时；提前 5 分钟续签，避免正好踩在边界上 */
const RENEW_AHEAD_MS = 5 * 60 * 1000;
const TTL_MS = 60 * 60 * 1000;

interface CachedUrl {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CachedUrl>();

/** 同一批 id 的并发请求合并成一次 —— 一篇笔记里十几张图会同时初始化 */
let inFlight: Promise<void> | null = null;
let inFlightIds = new Set<string>();

/** `attachment:abc123` → `abc123`；不是这个格式返回 null */
export function parseAttachmentRef(src: string | null | undefined): string | null {
  if (!src || !src.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = src.slice(ATTACHMENT_SCHEME.length).trim();
  return id.length > 0 ? id : null;
}

/** 从 Markdown 正文里收集所有附件引用（图片和链接都算） */
export function collectAttachmentIds(markdown: string): string[] {
  const ids = new Set<string>();
  const re = /attachment:([A-Za-z0-9_-]+)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(markdown)) !== null) ids.add(hit[1]);
  return [...ids];
}

/** 已签好且没过期的直接用 */
export function getAttachmentUrl(id: string): string | null {
  const hit = cache.get(id);
  if (!hit) return null;
  if (hit.expiresAt - RENEW_AHEAD_MS < Date.now()) return null;
  return hit.url;
}

/**
 * 确保这些 id 都有可用直链。
 *
 * 失败不抛：图片加载不出来应该是「裂图 + alt」，而不是整页渲染失败。
 */
export async function ensureSigned(ids: string[]): Promise<void> {
  const need = [...new Set(ids)].filter((id) => id && !getAttachmentUrl(id));
  if (need.length === 0) return;

  // 已经有请求在飞：等它，然后看自己还需要哪些
  if (inFlight) {
    await inFlight.catch(() => undefined);
    const still = need.filter((id) => !getAttachmentUrl(id));
    if (still.length === 0) return;
    return ensureSigned(still);
  }

  inFlightIds = new Set(need);
  inFlight = (async () => {
    try {
      const map = await signAttachments(need);
      const expiresAt = Date.now() + TTL_MS;
      for (const [id, path] of Object.entries(map ?? {})) {
        cache.set(id, { url: `${BASE}${path}`, expiresAt });
      }
    } catch {
      /* 拿不到签名就先保持裂图，下次渲染会重试 */
    } finally {
      inFlight = null;
      inFlightIds = new Set();
    }
  })();

  await inFlight;
}

/** 供调试 / 测试用：清空缓存，强制下次重新签 */
export function __resetAttachmentUrls() {
  cache.clear();
  inFlight = null;
  inFlightIds = new Set();
}

/** 仅供诊断：当前缓存了多少条、in-flight 批次的 id */
export function __attachmentUrlDebug() {
  return {
    cached: [...cache.keys()],
    inFlight: [...inFlightIds],
  };
}

/**
 * 把一棵 DOM 子树里的 `attachment:` 图片全部换掉。
 *
 * 用在预览区（dangerouslySetInnerHTML 之后）。返回的 Promise 完成时
 * `img.src` 已经是可用直链 —— 调用方不需要再触发重渲染。
 */
export async function hydrateAttachmentImages(root: HTMLElement): Promise<void> {
  const targets: { img: HTMLImageElement; id: string }[] = [];

  root.querySelectorAll('img').forEach((img) => {
    const id = parseAttachmentRef(img.getAttribute('src'));
    if (id) targets.push({ img, id });
  });

  if (targets.length === 0) return;

  await ensureSigned(targets.map((t) => t.id));

  for (const { img, id } of targets) {
    const url = getAttachmentUrl(id);
    if (url) img.src = url;
  }
}
