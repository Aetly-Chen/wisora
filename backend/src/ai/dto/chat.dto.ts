import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** POST /ai/chat/ticket 的请求体 */
export class ChatDto {
  /** 用户提问内容 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  question!: string;

  /** 会话 ID，不传则新建会话 */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
