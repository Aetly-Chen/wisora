import { Provider } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';

/**
 * LLM Provider 解耦：通过 ChatOpenAI + configuration.baseURL
 * 通吃 DeepSeek / 通义 / 豆包 / Kimi / 智谱等所有 OpenAI 兼容模型。
 * 换模型只改环境变量（OPENAI_BASE_URL / CHAT_MODEL_NAME 等）。
 */
export const CHAT_MODEL = 'CHAT_MODEL';

export const chatModelProvider: Provider = {
  provide: CHAT_MODEL,
  useFactory: () =>
    new ChatOpenAI({
      model: process.env.CHAT_MODEL_NAME ?? 'deepseek-chat',
      apiKey: process.env.OPENAI_API_KEY,
      temperature: Number(process.env.CHAT_MODEL_TEMPERATURE ?? 0.3),
      streaming: true,
      maxRetries: 1,
      timeout: Number(process.env.CHAT_STREAM_TIMEOUT_MS ?? 120_000),
      configuration: {
        // 注意：不要加 /v1，SDK 会自动补 /chat/completions
        baseURL: process.env.OPENAI_BASE_URL,
      },
    }),
};
