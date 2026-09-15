import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SkipResponse } from '../common/decorators/skip-response.decorator';
import {
  AttachmentsService,
  type UploadedFileLike,
} from './attachments.service';

/**
 * 附件上传与读取。
 *
 * 独立于 NotesController 的路径前缀（/attachments 而非 /notes/attachments）：
 * NotesController 上有 @Get(':id')，同级子路径会被它抢先匹配。
 */
@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** 上传：multipart/form-data，字段名 file，可选 noteId */
  @Post()
  @UseInterceptors(
    // 用内存存储：先过类型/大小校验再落盘，避免非法文件先写进磁盘
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  upload(
    @CurrentUser() userId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Query('noteId') noteId?: string,
  ) {
    return this.attachments.upload(userId, file, noteId);
  }

  @Get()
  list(@CurrentUser() userId: string, @Query('noteId') noteId?: string) {
    return this.attachments.list(userId, noteId);
  }

  /**
   * 读取附件内容。
   *
   * 同时用于预览与下载：
   * - 不传 download → Content-Disposition: inline（PDF/图片浏览器内直接渲染）
   * - 传 ?download=1 → attachment（强制下载）
   *
   * 必须 @SkipResponse()：全局拦截器会把流式响应包成 {code,msg,data}，
   * 二进制内容会被破坏。
   */
  @Get(':id/content')
  @SkipResponse()
  async content(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('download') download?: string,
  ) {
    const { attachment, buffer } = await this.attachments.readContent(userId, id);

    // 文件名含中文时需用 RFC 5987 编码，否则部分浏览器会乱码
    const encoded = encodeURIComponent(attachment.filename);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`,
    );
    res.end(buffer);
  }

  @Delete(':id')
  remove(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.attachments.remove(userId, id);
  }
}
