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

  /**
   * 移动：改为挂到另一个页面下。传 null 表示移到顶层。
   *
   * 注意「不传」与「传 null」语义不同：不传 = 不动层级，
   * 传 null = 移动到顶层。IsOptional 对两者都放行，
   * 区分由 service 里判断 `!== undefined` 完成。
   *
   * 环与层级的校验在 NotesService.move 里。
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  parentId?: string | null;

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
