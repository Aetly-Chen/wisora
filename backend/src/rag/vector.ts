/**
 * 向量工具：Float32Array ↔ bytea 互转，以及余弦相似度。
 *
 * 为什么不引向量库、不装 pgvector —— 见 schema.prisma 里 NoteChunk 的注释。
 */

/**
 * 编码成可直接写进 bytea 的字节。
 *
 * 复制而不是共享 ArrayBuffer，两个原因：
 * 1. Prisma 的 Bytes 要求底层是 ArrayBuffer，而 Buffer 的类型是
 *    `Buffer<ArrayBufferLike>`（可能由 SharedArrayBuffer 支撑），类型对不上；
 * 2. 1024 维才 4KB，拷贝成本可以忽略，换来的是写入期间源向量被改动也不影响结果。
 */
export function encodeVector(vec: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(vec.byteLength);
  out.set(new Uint8Array(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength));
  return out;
}

/**
 * 从 bytea 还原向量。
 *
 * ⚠️ 必须检查 byteOffset 是否 4 字节对齐：Node 的 Buffer 有时来自共享内存池，
 * byteOffset 不是 4 的倍数时直接 `new Float32Array(buf.buffer, buf.byteOffset, …)`
 * 会抛 "start offset of Float32Array should be a multiple of 4"。
 * 这种情况下退回复制一份再构造 —— 多一次拷贝，但绝不会在运行时炸。
 */
export function decodeVector(bytes: Uint8Array): Float32Array {
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length / 4);
  }
  const copy = new Float32Array(bytes.length / 4);
  new Uint8Array(copy.buffer).set(bytes);
  return copy;
}

/** 向量维度（按字节数推算），用于校验读回来的数据没坏 */
export function vectorDimension(buf: Buffer): number {
  return buf.length / 4;
}

/**
 * 余弦相似度。
 *
 * 不做归一化预处理：实测（1024 维、2 万条）归一化后走纯点积只快 1.1~1.4 倍，
 * 瓶颈在内存访问而不是乘法，多维护一份归一化副本不划算。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
