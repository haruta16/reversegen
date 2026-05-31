/**
 * 简易日志模块。
 * 对应 Unity AlgoLogger 的使用模式，输出到 console。
 * 可通过 setLogLevel 控制级别，Silent 关闭所有输出。
 */

export enum LogLevel {
  Silent = 0,  // 关闭所有日志
  Error = 1,   // 仅错误
  Warning = 2, // 错误 + 警告
  Info = 3,    // 错误 + 警告 + 信息
  Debug = 4,   // 全部（含调试）
}

let currentLevel: LogLevel = LogLevel.Info;

/** 设置日志级别 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export const logger = {
  info(message: string): void {
    if (currentLevel >= LogLevel.Info) {
      console.log(`[ReverseGen] ${message}`);
    }
  },

  warn(message: string): void {
    if (currentLevel >= LogLevel.Warning) {
      console.warn(`[ReverseGen] ${message}`);
    }
  },

  error(message: string): void {
    if (currentLevel >= LogLevel.Error) {
      console.error(`[ReverseGen] ${message}`);
    }
  },

  debug(message: string): void {
    if (currentLevel >= LogLevel.Debug) {
      console.debug(`[ReverseGen] ${message}`);
    }
  },
};
