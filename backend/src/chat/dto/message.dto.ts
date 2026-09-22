import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 发消息。
 *
 * 注意这里收的是 `attachmentId` / `noteId`，不是完整的附件对象或笔记对象。
 * 前端适配层负责把 `payload.attachment.id` 拍平成 `attachmentId`。
 *
 * 为什么不让前端传完整对象：`note.title` 这类字段一旦由客户端提供，
 * 就可以伪造标题把别人的笔记发出去（后端会按 noteId 自己取快照）。
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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  noteId?: string;
}
