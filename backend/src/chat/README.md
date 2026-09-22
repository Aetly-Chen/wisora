# chat 模块

聊天：好友、单聊 / 群聊、文本 / 图片 / 文件 / 笔记分享、实时推送。
接口与网关**均已落地并实测通过**（后端 72/72、浏览器端到端 29/29）。

配套文档：

- 设计意图与接口约定 → `docs/chat-module-design.md`
- 逐文件实现说明与落地顺序 → `docs/chat-backend-implementation.md`

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `chat.module.ts` | 装配；顺带挂一个孤儿附件清理定时器 |
| `chat.controller.ts` | REST：好友 / 会话 / 消息 / 附件 / 分享。全部挂 `JwtAuthGuard` |
| `chat.gateway.ts` | WebSocket 网关（命名空间 `chat`）：在线状态、输入中、已读、新消息推送 |
| `chat.mapper.ts` | **库行 → 接口出参的唯一转换点**。Message 形状在 4 处都要拼，集中在这里 |
| `friends.service.ts` | 好友关系（双向写、搜索脱敏、在线状态） |
| `conversations.service.ts` | 会话（单聊复用、建群、置顶 / 免打扰、已读、成员鉴权） |
| `messages.service.ts` | 消息（游标分页、三种消息写入、未读累加） |
| `share.service.ts` | 分享笔记给好友（逐个建 / 复用单聊后写卡片） |
| `chat-attachments.service.ts` | 附件（校验、落盘、鉴权读取、孤儿清理） |
| `dto/` | 请求体形状。**注意全局没有 `ValidationPipe`，装饰器目前不生效** |
| `types/chat-events.ts` | 出参与实时事件形状，与前端 `types/chat.ts` 一一对应 |

## 改这个模块时最容易踩的四点

1. **校验必须写在 service 里**。项目没有注册全局 `ValidationPipe`，
   `@IsString()` 这类装饰器只是文档。DTO 里写一遍是为了日后开了管道立刻生效，
   不是当前的防线。

2. **消息形状只改 `chat.mapper.ts`**。前后的字段对齐只在这一处维护；
   散到各个 service 里迟早漏一个（笔记模块当年 `create` 漏返回 `attachments`
   就是这么来的）。

3. **业务事件只用 `pushToMembers`**，别用 `server.emit`。
   广播会把消息推给不相干的人，而且这种错在小规模测试里看不出来。

4. **归属校验的错误码是 404 不是 403**。403 会告诉调用方「资源存在但你无权」，
   可以被用来枚举他人会话 / 笔记 id。「不存在」与「无权访问」返回同一文案。

## 常用命令

```bash
cd backend

node test/verify-chat.cjs         # 接口层 72 项断言
node test/probe-chat-ws.cjs       # 探测运行中的服务是否挂上了 chat 命名空间
node test/seed-chat-demo.cjs --me <你的邮箱>   # 造演示数据
node test/seed-chat-demo.cjs --reset          # 清掉演示数据
```
