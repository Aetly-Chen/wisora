import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 附件实体存储。
 *
 * 当前落在本地磁盘（默认 <项目根>/uploads），只把元数据写库。
 * 之所以抽成 Service：之后换对象存储（S3 / OSS）只需替换这里的实现，
 * 上层 NotesService 与 Controller 不用动。
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root = path.resolve(
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads'),
  );

  /** 单文件大小上限（字节），默认 20MB */
  readonly maxSize = Number(process.env.UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024);

  /**
   * 落盘并返回 storageKey。
   *
   * 文件名用随机 UUID + 原扩展名：既避免同名覆盖，
   * 也杜绝用上传文件名拼路径导致的路径穿越。
   */
  async save(buffer: Buffer, originalName: string): Promise<string> {
    await fs.mkdir(this.root, { recursive: true });

    const ext = path.extname(originalName).toLowerCase().slice(0, 16);
    const storageKey = `${randomUUID()}${ext}`;
    await fs.writeFile(path.join(this.root, storageKey), buffer);

    this.logger.log(`附件落盘 ${storageKey}（${buffer.length} 字节）`);
    return storageKey;
  }

  /**
   * 解析 storageKey 对应的绝对路径。
   *
   * storageKey 来自数据库（我们自己生成的），仍再校验一次解析结果
   * 必须落在 root 内，防止脏数据造成越权读取。
   */
  resolvePath(storageKey: string): string {
    const full = path.resolve(this.root, storageKey);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new NotFoundException('附件不存在');
    }
    return full;
  }

  async read(storageKey: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolvePath(storageKey));
    } catch {
      // 库里有记录但磁盘文件没了：对调用方就是"不存在"
      throw new NotFoundException('附件文件已丢失');
    }
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(storageKey));
    } catch (err) {
      // 文件已不在不影响删除记录，只留日志
      this.logger.warn(
        `删除附件文件失败 ${storageKey}: ${(err as Error).message}`,
      );
    }
  }
}
