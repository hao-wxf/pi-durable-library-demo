# pi-durable 图书管理工作台

一个可以直接运行的 `@earendil-works/pi-durable` 演示。页面里有馆藏、借阅、预约、采购审批、批量借阅和 AI 助手;顶部可以杀掉工作进程再重启,用来看已提交状态和未完成任务如何恢复。

## 运行

要求 Node.js >= 22.19.0。

```bash
npm install
npm start
```

打开 <http://localhost:8791>。

不需要构建步骤。服务器直接用 Node 的类型剥离运行 `web/server.ts`,它再启动唯一打开 SQLite 的工作进程。

## AI 助手

没有密钥时,助手使用 faux 提供方返回固定回答,其他功能和恢复流程不受影响。

要接真实的 DeepSeek:

```bash
# macOS / Linux
export DEEPSEEK_API_KEY=sk-...
npm start

# Windows PowerShell
$env:DEEPSEEK_API_KEY="sk-..."
npm start
```

也会读取 `~/.pi/agent/auth.json` 里的 `deepseek.key`。

## 演示崩溃恢复

1. 点“借阅”,在书进入“处理中”的五秒窗口内点“杀掉服务”。
2. 页面会通过只读的 inspect 进程显示已提交状态。
3. 点“重启服务”。借阅任务从检查点继续,库存只扣一次。

预约、批量入库、采购审批和批量借阅也可以用同样方式打断。

## 数据位置

默认写入 `.library-web/library.sqlite`。可以用参数改端口和目录:

```bash
npm start -- --port 9000 --dir my-data
```

删除 `.library-web` 目录即可回到初始数据;下次启动会重新播种。

## 结构

| 文件 | 作用 |
|---|---|
| `library.ts` | 文档、五个 durable 任务、工具和扩展 |
| `web/worker.ts` | 唯一打开存储的进程,负责恢复任务和处理命令 |
| `web/server.ts` | HTTP/SSE 监督者,不打开存储 |
| `web/index.html` | 页面 |
| `provider.ts` | DeepSeek 或 faux 模型提供方 |

## 依赖

- `@earendil-works/pi-durable` 1.1.0
- `@earendil-works/chord` 1.1.0
- `@earendil-works/pi-ai` 1.1.0
- `typebox` 1.3.27
