/**
 * 简易日志模块。
 * 对应 Unity AlgoLogger 的使用模式，输出到 console。
 *
 * Logger 实例独立持有日志级别，测试可用 new Logger(LogLevel.Silent) 隔离。
 * 默认导出的 logger / setLogLevel 保持向后兼容，行为不变。
 */

export enum LogLevel {
  Silent = 0,  // 关闭所有日志
  Error = 1,   // 仅错误
  Warning = 2, // 错误 + 警告
  Info = 3,    // 错误 + 警告 + 信息
  Debug = 4,   // 全部（含调试）
}

export class Logger {
  level: LogLevel;

  constructor(level: LogLevel = LogLevel.Info) {
    this.level = level;
  }

  info(message: string): void {
    if (this.level >= LogLevel.Info) {
      console.log(`[ReverseGen] ${message}`);
    }
  }

  warn(message: string): void {
    if (this.level >= LogLevel.Warning) {
      console.warn(`[ReverseGen] ${message}`);
    }
  }

  error(message: string): void {
    if (this.level >= LogLevel.Error) {
      console.error(`[ReverseGen] ${message}`);
    }
  }

  debug(message: string): void {
    if (this.level >= LogLevel.Debug) {
      console.debug(`[ReverseGen] ${message}`);
    }
  }
}

/** 默认全局 logger 实例，向后兼容 */
export const logger = new Logger(LogLevel.Info);

/** 设置默认 logger 的日志级别。向后兼容，等价于 logger.level = level */
export function setLogLevel(level: LogLevel): void {
  logger.level = level;
}
