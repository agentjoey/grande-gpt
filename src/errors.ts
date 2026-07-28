/** 只有 `.code` 的最小结构化错误。tasks.ts/jobs.ts 从裸 Error 迁到这里。 */
export class StateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `StateError [${code}]`;
    this.code = code;
  }
}
