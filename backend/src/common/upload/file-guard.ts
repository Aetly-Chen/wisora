import { BadRequestException } from '@nestjs/common';

/**
 * multer 上传文件的形状。
 *
 * 本地声明而不是依赖 @types/multer：项目里 multer 只是
 * @nestjs/platform-express 的传递依赖，为一个类型引入新的 types 包不划算。
 */
export interface UploadedFileLike {
  originalname: string; // 客户端上传的原始文件名，中文名需还原编码
  mimetype: string; // 客户端声明的 MIME 类型，按白名单校验后落盘
  size: number; // 字节数，用于空文件与体积上限判断
  buffer: Buffer; // 内存里的文件内容（multer 用 memoryStorage）
}

/**
 * 允许上传的类型白名单。
 *
 * 刻意不做通配放行：上传目录同源可访问，若放任 .html / .svg 等
 * 可执行脚本的类型落盘，等于给自己开了个存储型 XSS 的口子。
 * text/html、image/svg+xml、application/x-msdownload 一律不放行。
 */
export const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/markdown',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Office 文档：支持上传与下载，前端不做在线预览
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 聊天场景额外放行的两类（笔记那边用不到）
  'application/zip',
  'application/x-zip-compressed',
  'video/mp4',
]);

/**
 * 还原文件名编码。
 *
 * multer 对 multipart 里的文件名按 latin1 解码，中文名会变成
 * "æµè¯ææ¡£.pdf" 这样的乱码 —— 字节本身没错（仍是 UTF-8 序列），
 * 只是被当成了单字节字符。这里按 latin1 读回字节再解成 UTF-8。
 *
 * 加两道判断是因为存在两种情况：
 *   1. 名字含 0x80–0xFF 的高位字符 → 属于 latin1 误读，需要还原
 *   2. 客户端已正确按 UTF-8 传（字符码 > 0xFF）→ 原样返回
 * 还原结果若含替换字符 U+FFFD，说明本就不是误读，同样保持原样。
 */
export function decodeFilename(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/**
 * 校验上传文件：非空 → 体积 → MIME 白名单。
 *
 * 注意校验顺序是「先小后大」：体积检查是纯计算，
 * MIME 检查要看集合，先做便宜的。
 */
export function assertUploadable(
  file: UploadedFileLike,
  maxBytes: number,
): void {
  if (file.size === 0) {
    throw new BadRequestException('文件为空，无法上传');
  }
  if (file.size > maxBytes) {
    throw new BadRequestException(
      `单个文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`,
    );
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new BadRequestException(`不支持的文件类型：${file.mimetype}`);
  }
}
