import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * 创建会话。
 *
 * 单聊与群聊共用一个 DTO 而不是拆两个：路径相同（POST /chat/conversations），
 * 只在 body 里用 kind 区分。跨字段的约束（kind=direct 必须给 friendId、
 * kind=group 必须给 title+memberIds）没法用装饰器表达，
 * 由 ConversationsService.create 负责校验。
 */
export class CreateConversationDto {
  @IsIn(['direct', 'group'], { message: 'kind 只能是 direct 或 group' })
  kind!: 'direct' | 'group';

  /** kind=direct 时必填 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  friendId?: string;

  /** kind=group 时必填 */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  title?: string;

  /** kind=group 时必填，不需要包含自己（后端会加） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100, { message: '群成员最多 100 人' })
  memberIds?: string[];
}

export class UpdateConversationDto {
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsBoolean()
  muted?: boolean;
}
