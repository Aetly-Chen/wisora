import { Injectable, Logger } from '@nestjs/common';

/**
 * 文本向量化。
 *
 * 走 OpenAI 兼容的 embeddings 接口，当前接的是 SiliconFlow 的
 * Qwen/Qwen3-Embedding-0.6B（原生 1024 维）。换厂商只改 .env 里的
 * EMBEDDING_BASE_URL / EMBEDDING_MODEL —— 和 ChatModelFactory 同一套路。
 *
 * ⚠️ 维度不是随便选的：pgvector 的 HNSW 索引上限是 2000 维，而 Qwen3-Embedding
 * 的 4B/8B 默认输出 2560/4096 维。0.6B 最大就是 1024，天然安全。
 * 换模型时 EMBEDDING_DIMENSIONS 必须跟着改，并且**重建全部索引** ——
 * 新旧维度的向量不可比，混着用不会报错，只会搜出莫名其妙的结果。
 */

/** 单批条数。留余量，避免撞上服务端对 input 数组长度的限制 */
const BATCH_SIZE = 16;

/** 单次请求超时。embedding 比 chat 快得多，30s 足够 */
const TIMEOUT_MS = 30_000;

/** 失败重试次数。向量化是只读操作、幂等，重试没有副作用 */
const RETRIES = 1;

interface EmbeddingResponse {
  code?: number | string;
  message?: string;
  data?: { index: number; embedding: number[] }[];
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  /**
   * 是否可用。
   *
   * 没配 key 时整个 RAG 链路降级：索引与检索都直接返回空，
   * 而不是抛错 —— 检索只是锦上添花，不该因为它没配好就让
   * 「保存笔记」这种主流程失败。
   */
  get enabled(): boolean {
    return Boolean(process.env.EMBEDDING_API_KEY);
  }

  get dimension(): number {
    return Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
  }

  /**
   * 批量向量化，返回顺序与入参严格一致。
   *
   * 分批串行发送：索引是全量任务、通常跑在后台，慢一点无所谓；
   * 而「保存一篇笔记」一般只有几个块，一批就发完了。
   * 串行换来的是不会把上游打爆，也不会因为并发写顺序乱掉。
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.enabled) throw new Error('未配置 EMBEDDING_API_KEY');
    if (texts.length === 0) return [];

    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      out.push(...(await this.embedBatch(texts.slice(i, i + BATCH_SIZE))));
    }
    return out;
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        return await this.callApi(texts);
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `向量化第 ${attempt + 1} 次失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw lastError;
  }

  private async callApi(texts: string[]): Promise<Float32Array[]> {
    const base = (process.env.EMBEDDING_BASE_URL ?? '').replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.EMBEDDING_MODEL,
          input: texts,
          dimensions: this.dimension,
        }),
        signal: controller.signal,
      });

      const body = (await res.json()) as EmbeddingResponse;
      if (!res.ok || body.code) {
        throw new Error(`HTTP ${res.status} ${body.message ?? JSON.stringify(body)}`);
      }

      const rows = body.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(`返回条数不符：期望 ${texts.length}，实际 ${rows.length}`);
      }

      // 按 index 排序，不假设服务端一定按序返回
      return rows
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((row) => {
          const vec = Float32Array.from(row.embedding);
          /*
           * 维度校验不能省。换模型或改 EMBEDDING_DIMENSIONS 后，如果库里
           * 还留着旧维度的向量，检索不会报错 —— 余弦相似度照样算得出一个
           * 数字，只是完全没意义。宁可在写入时就炸掉。
           */
          if (vec.length !== this.dimension) {
            throw new Error(
              `向量维度不符：期望 ${this.dimension}，实际 ${vec.length}（是不是换了模型没重建索引？）`,
            );
          }
          return vec;
        });
    } finally {
      clearTimeout(timer);
    }
  }
}
