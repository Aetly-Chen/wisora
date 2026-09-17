import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';

/**
 * LLM 接入层。
 *
 * 通过 ChatOpenAI + configuration.baseURL 通吃 DeepSeek / 通义 / 豆包 /
 * Kimi / 智谱等所有 OpenAI 兼容模型 —— 换厂商只改 OPENAI_BASE_URL。
 *
 * 与最初版本的区别：那时只提供一个单例模型，模型名写死在环境变量里；
 * 现在支持前端切换模型，所以改成按模型名缓存实例的工厂。
 * 环境变量里的 CHAT_MODEL_NAME 从「唯一模型」变成「默认模型」。
 */

/** 默认模型（请求未指定时使用） */
export function defaultModelName(): string {
  return process.env.CHAT_MODEL_NAME?.trim() || 'deepseek-chat';
}

/**
 * 可切换的模型列表。
 *
 * 由 CHAT_MODEL_OPTIONS 以逗号分隔配置；未配置时退化为只含默认模型，
 * 这样老部署不改配置也能正常跑（前端会显示成只有一个选项）。
 * 默认模型始终并入列表，避免出现「当前模型不在可选项里」的尴尬状态。
 */
export function availableModelNames(): string[] {
  const raw = process.env.CHAT_MODEL_OPTIONS?.trim();
  const configured = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  return [...new Set([defaultModelName(), ...configured])];
}

@Injectable()
export class ChatModelFactory {
  private readonly logger = new Logger(ChatModelFactory.name);
  /** 按模型名缓存实例：ChatOpenAI 构造有开销，且复用连接池 */
  private readonly cache = new Map<string, ChatOpenAI>();

  /**
   * 把外部传入的模型名解析成实际使用的模型。
   *
   * 白名单校验是必须的：model 参数来自 query，若不校验，
   * 调用方可以塞任意字符串让服务端去请求 —— 轻则报错，
   * 重则被用来探测上游有哪些模型。不在白名单时回落默认模型并记日志。
   */
  resolve(requested?: string): string {
    const name = requested?.trim();
    if (!name) return defaultModelName();

    if (availableModelNames().includes(name)) return name;

    this.logger.warn(
      `请求了未配置的模型「${name}」，已回落至 ${defaultModelName()}`,
    );
    return defaultModelName();
  }

  get(modelName: string): ChatOpenAI {
    const cached = this.cache.get(modelName);
    if (cached) return cached;

    const instance = new ChatOpenAI({
      model: modelName,
      apiKey: process.env.OPENAI_API_KEY,
      temperature: Number(process.env.CHAT_MODEL_TEMPERATURE ?? 0.3),
      streaming: true,
      maxRetries: 1,
      timeout: Number(process.env.CHAT_STREAM_TIMEOUT_MS ?? 120_000),
      configuration: {
        // 注意：不要加 /v1，SDK 会自动补 /chat/completions
        baseURL: process.env.OPENAI_BASE_URL,
      },
    });

    this.cache.set(modelName, instance);
    return instance;
  }
}
