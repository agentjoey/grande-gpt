# Resource & Performance Governance Implementation Plan

第二批在 lifecycle correctness 完成后开始，顺序：

1. per-task / global job admission
2. controlled job cancel
3. dependency cache / artifact / log retention
4. low-disk admission protection
5. compact + paginated task status
6. repo_map serialized-byte-aware pagination
7. status path Git subprocess / filesystem traversal 去重

约束：不开放通用 shell；资源回收依赖第一批 cleanup eligibility，不能用简单 TTL 删除 active worktree；每项保持 bounded change 与比例测试。
