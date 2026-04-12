工具：get_message_context

何时用：
- 需要核对少量关键消息原文，避免全量展开。

调用建议：
- 只传必要 items（sessionId + localId），每次少量（<=20）。
- 默认 minimal；需要上下文再用 standard/full。
