import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NotesService } from './notes.service';
import { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';

/**
 * 笔记 CRUD。
 *
 * 全部接口挂在 JwtAuthGuard 下；userId 一律从令牌取，
 * 不接受客户端传入，从源头上杜绝冒用他人身份。
 */
@Controller('notes')
@UseGuards(JwtAuthGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  /** 列表，支持关键词搜索（标题 + 正文） */
  @Get()
  list(@CurrentUser() userId: string, @Query('keyword') keyword?: string) {
    return this.notes.list(userId, keyword?.trim() || undefined);
  }

  @Post()
  create(@CurrentUser() userId: string, @Body() dto: CreateNoteDto) {
    return this.notes.create(userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.notes.get(userId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.notes.update(userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.notes.remove(userId, id);
  }
}
