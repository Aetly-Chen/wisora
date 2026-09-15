import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotesController } from './notes.controller';
import { AttachmentsController } from './attachments.controller';
import { NotesService } from './notes.service';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Module({
  // JwtAuthGuard 依赖 JwtService 验签（非全局 Guard，逐控制器挂载）
  imports: [JwtModule.register({})],
  controllers: [NotesController, AttachmentsController],
  providers: [NotesService, AttachmentsService, StorageService, JwtAuthGuard],
})
export class NotesModule {}
