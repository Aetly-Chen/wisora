import { Injectable, BadRequestException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class VerificationCodeService {
  constructor(private readonly redisService: RedisService) {}

  async generate(type: string, email: string) {
    const redis = this.redisService.getClient();

    const key = `verify-code:${type}:${email}`;

    const cooldownKey = `verify-code:cooldown:${type}:${email}`;

    // 检查发送冷却
    const cooldown = await redis.get(cooldownKey);

    if (cooldown) {
      throw new BadRequestException('验证码发送过于频繁，请稍后再试');
    }

    // 生成6位验证码
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // 验证码保存5分钟
    await redis.set(key, code, 'EX', 300);

    // 60秒发送冷却
    await redis.set(cooldownKey, '1', 'EX', 60);

    return code;
  }
  async verify(type: string, email: string, code: string) {
    const redis = this.redisService.getClient();

    const key = `verify-code:${type}:${email}`;

    const savedCode = await redis.get(key);

    if (!savedCode) {
      throw new BadRequestException('验证码已过期');
    }

    if (savedCode !== code) {
      throw new BadRequestException('验证码错误');
    }

    // 验证成功后立即删除
    await redis.del(key);

    return true;
  }
}
