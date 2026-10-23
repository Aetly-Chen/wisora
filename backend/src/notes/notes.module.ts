import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotesController } from './notes.controller';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsPublicController } from './attachments-public.controller';
import { NotesService } from './notes.service';
import { AttachmentsService } from './attachments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Module({
  // JwtAuthGuard 依赖 JwtService 验签（非全局 Guard，逐控制器挂载）
  imports: [JwtModule.register({})],
  controllers: [NotesController, AttachmentsController, AttachmentsPublicController],
  providers: [NotesService, AttachmentsService, JwtAuthGuard],
  /*
   * 导出给 AiModule：AI 的笔记工具必须复用 NotesService，而不是自己查 Prisma。
   * 层级上限、移动环检测、子树级联软删这些规则只应有一份实现 ——
   * 在工具里另写一套，AI 这条路径就会绕过校验（能把页面挂到第 8 层、
   * 把目录移进自己的后代形成环）。
   */
  exports: [NotesService],
})
export class NotesModule {}
