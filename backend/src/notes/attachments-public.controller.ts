import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SkipResponse } from '../common/decorators/skip-response.decorator';
import { AttachmentsService } from './attachments.service';

/**
 * 附件直链（无 Authorization 头）。
 *
 * 存在的唯一理由：`<img src>`、CSS `url()`、`<a download>` 这些浏览器原生的
 * 资源加载**带不了 Bearer 头**，所以在挂了 JwtAuthGuard 的
 * `/attachments/:id/content` 上取图片必定 401。
 *
 * 授权模型换成「签名即凭证」（与 S3 presigned URL 同理）：
 * 链接由 AttachmentsService.signMany 用自己的身份换出来，带 id + 过期时间 + HMAC，
 * 任何人都能在有效期内读**这一张**附件，不能读别的、不能续签。
 *
 * ⚠️ 刻意不挂 JwtAuthGuard —— 挂了就等于要求浏览器在 img 请求里塞 token。
 * 安全性靠签名本身，不靠身份。
 */
@Controller('attachments')
export class AttachmentsPublicController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/raw')
  @SkipResponse()
  async raw(
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const { attachment, buffer } = await this.attachments.readBySignature(id, exp, sig);

    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', buffer.length);
    /*
     * 缓存上限压到 10 分钟，比签名有效期（1 小时）短得多：
     * 这样链接过期后浏览器不会继续拿缓存里的旧响应糊弄。
     */
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    );
    res.end(buffer);
  }
}
