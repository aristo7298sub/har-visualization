---
name: har2md
description: 将 Voice Live / Realtime API 的 HAR 文件转为结构化 Markdown 报告并分析。支持两种模式：分析模式（过滤关键事件 + 诊断建议）和 Raw 模式（完整事件 dump）。用于调查语音截断、VAD 误判、AEC 失效、取消率异常。
argument-hint: <har-file-path> [--raw]
---

# HAR → Markdown 转换与分析

将客户提供的 HAR 文件转为结构化 Markdown，提取关键信息并分析诊断。

## 执行流程

### 1. 转换 HAR → Markdown

脚本位置：`har_to_md.py`（本 skill 同级项目根目录）

**分析模式**（默认，过滤高频事件，输出诊断建议）：
```bash
python har_to_md.py $ARGUMENTS
```

**Raw 模式**（完整事件 dump，含截断的 audio payload，适合深度分析）：
```bash
python har_to_md.py $ARGUMENTS --raw
```

**指定输出路径**：
```bash
python har_to_md.py <input.har> --output <output.md>
```

**仅分析指定 session**：
```bash
python har_to_md.py <input.har> --session-id sess_xxx
```

无外部依赖，仅使用 Python 标准库。

### 2. 读取报告并提取关键信息

转换完成后，读取生成的 .md 文件，关注以下模块：

| 模块 | 关注点 |
|------|--------|
| Session 配置 | VAD 类型/参数、是否启用 AEC、降噪、Voice 名称、Rate |
| 统计总览 | 取消率（>30% 异常）、VAD speech_started 触发次数 |
| Response 生命周期 | 哪些被 cancelled、有无 audio_deltas、speech_started_during |
| 对话流 | 用户实际说了什么、Agent 回复了什么、哪些被截断 |
| 事件时间线 | speech_started 与 response.audio.delta 的时间关系 |
| 诊断建议 | 脚本自动生成的初步建议 |

### 3. 深入分析（基于报告内容）

按以下清单逐项检查：

**取消率**：
- 0-token cancelled + reason=turn_detected → 正常 barge-in
- 有 audio_deltas + cancelled → 用户已听到部分内容后被截断（异常）
- 大量 0-token cancelled → VAD 过灵敏或环境噪音

**AEC / 回声**：
- completed response 期间触发 speech_started → AEC 可能失效
- 确认是否启用了 `server_echo_cancellation`

**音频截断**：
- transcript.done=True 但 audio.done=False → 服务端音频流中断

**VAD 配置**：
- `silence_duration_ms` < 300 → 可能过灵敏
- `auto_truncate: false` + 有取消 → 对话历史可能不一致

### 4. 输出结论

```markdown
## HAR 分析结论

### 基本信息
- Session ID: ...
- 总事件数: ... | Response 数: ... | 取消率: ...%

### 发现的问题
1. [🔴/⚠️/ℹ️] 问题描述 — 证据 — 建议

### 对话内容摘要
1. 用户: ...
2. Agent: ...

### 建议操作
- ...
```

## 诊断模式速查

| 模式 | 表现 | 原因 | 建议 |
|------|------|------|------|
| speech_started 紧跟 audio.delta | Agent 说话时 VAD 触发 | AEC 失效 | 启用 server_echo_cancellation |
| 大量 0-token cancelled | 模型没开口就被取消 | VAD 过灵敏 | 增大 silence_duration_ms |
| 高 token cancelled | 长句被截断 | 用户打断 / AEC 延迟 | 正常或优化 AEC |
| speech_started >> response 数 | VAD 过度触发 | 设备 / 无 AEC | 启用 AEC + 降噪 |
| transcript.done 无 audio.done | 音频截断 | Backend 问题 | 查后端日志 |
| auto_truncate=false + cancelled | 对话历史不一致 | 配置缺失 | 开启 auto_truncate |

## 后续深入（可选）

结合 Kusto 后端日志：
- `session_id` → TraceCallResult（cogsvc）
- `response_id` → VoiceLive_ResponseDone
- 对比前后端事件时间差
