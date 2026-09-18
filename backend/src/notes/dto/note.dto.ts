import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(120, { message: '标题最长 120 字' })
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  /**
   * 父页面 id。不传即顶层页面。
   * 归属与层级深度在 NotesService.resolveParent 里校验。
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  parentId?: string;
}

export class UpdateNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(120, { message: '标题最长 120 字' })
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

/** 附件上传：可选地直接挂到某篇笔记下 */
export class UploadAttachmentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  noteId?: string;
}
