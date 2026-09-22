import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * 分享笔记给好友。
 *
 * 刻意只有 noteId，没有 title / childCount ——
 * 后端按 noteId 调 NotesService.get() 自己取快照，顺带完成归属校验。
 * 接收前端标题意味着可以伪造。
 */
export class ShareNoteDto {
  @IsString()
  @IsNotEmpty({ message: '缺少 noteId' })
  noteId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: '请至少选择一位好友' })
  @ArrayMaxSize(50, { message: '一次最多分享给 50 位好友' })
  @IsString({ each: true })
  toFriendIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '附言最多 200 字' })
  comment?: string;
}
