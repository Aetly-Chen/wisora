import { Injectable } from '@nestjs/common'
import * as nodemailer from 'nodemailer'

@Injectable()
export class MailService {
  private transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT),
    secure: true,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASSWORD,
    },
  })

  async sendRegisterCode(
    email: string,
    code: string,
  ) {
    const result = await this.transporter.sendMail({
      from: `"Wisora" <${process.env.MAIL_FROM}>`,
      to: email,
      subject: 'Wisora 验证码',
      text: `你的验证码是：${code}，5分钟内有效。`,
      html: `
        <div style="padding: 30px; font-family: Arial, sans-serif;">
          <h2>Wisora 验证码</h2>

          <p>你好，欢迎使用 Wisora。</p>

          <p>你的验证码是：</p>

          <div style="
            font-size: 32px;
            font-weight: bold;
            letter-spacing: 8px;
            margin: 20px 0;
          ">
            ${code}
          </div>

          <p>验证码 5 分钟内有效，请勿泄露给他人。</p>

          <p style="color: #999;">
            如果这不是你的操作，请忽略此邮件。
          </p>
        </div>
      `,
    })

    console.log('邮件发送成功:', result.messageId)

    return result
  }
}