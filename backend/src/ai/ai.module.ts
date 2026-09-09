import { Module, OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { chatModelProvider } from './llm/llm.provider';
import { ToolRegistry } from './tools/tool.registry';
import { registerAllTools } from './tools';
import { ConversationRepository } from './memory/conversation.repository';
import { RateLimitService } from './rate-limit.service';
import { StreamTicketGuard } from './guards/stream-ticket.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [
    PrismaModule,
    // RedisModule 是 @Global()，无需重复导入
    // ticket 换票接口需要验证 JWT（stream 走一次性 ticket，不走这里）
    JwtModule.register({}),
  ],
  controllers: [AiController],
  providers: [
    AiService,
    ToolRegistry,
    ConversationRepository,
    RateLimitService,
    StreamTicketGuard,
    chatModelProvider,
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
