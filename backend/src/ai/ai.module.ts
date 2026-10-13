import { Module, OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ChatModelFactory } from './llm/llm.provider';
import { ToolRegistry } from './tools/tool.registry';
import { registerAllTools } from './tools';
import { ConversationRepository } from './memory/conversation.repository';
// RateLimitService 已移到 common：chat 也要用它，
// 留在 ai 里会让 chat 反向依赖 ai
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { StreamTicketGuard } from './guards/stream-ticket.guard';
import { PrismaService } from '../prisma/prisma.service';
import { NotesModule } from '../notes/notes.module';

@Module({
  imports: [
    NotesModule,

    /*
     * PrismaModule / RedisModule / StorageModule / RateLimitModule / RagModule
     * 都是 @Global()，已在 app.module.ts 挂过，这里不再重复 imports。
     */
    // ticket 换票接口需要验证 JWT（stream 走一次性 ticket，不走这里）
    JwtModule.register({}),
  ],
  controllers: [AiController],
  providers: [
    AiService,
    ToolRegistry,
    ConversationRepository,
    StreamTicketGuard,
    ChatModelFactory,
  ],
  exports: [AiService],
})
export class AiModule implements OnModuleInit {
  constructor(
    private readonly tools: ToolRegistry,
    // 注入 PrismaService 用于工具工厂
    private readonly prisma: PrismaService,
  ) {}

  /** 应用启动时注册所有业务工具 */
  onModuleInit() {
    registerAllTools(this.tools, this.prisma);
  }
}
