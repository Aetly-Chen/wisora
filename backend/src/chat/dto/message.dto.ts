import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 发消息。
 *
 * 注意这里收的是 `attachmentId`，不是完整的附件对象。
 * 前端适配层负责把 `payload.attachment.id` 拍平成 `attachmentId`。
 */
export class SendMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000, { message: '单条消息最多 4000 字' })
  text?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  attachmentId?: string;
}
