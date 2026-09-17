import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Module({
  // JwtAuthGuard 依赖 JwtService 验签（非全局守卫，逐控制器挂载）
  imports: [JwtModule.register({})],
  controllers: [UserController],
  providers: [UserService, JwtAuthGuard],
})
export class UserModule {}
