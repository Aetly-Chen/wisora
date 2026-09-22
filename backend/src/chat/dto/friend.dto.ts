import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddFriendDto {
  @IsString()
  @IsNotEmpty({ message: '缺少 userId' })
  @MaxLength(64)
  userId!: string;
}
