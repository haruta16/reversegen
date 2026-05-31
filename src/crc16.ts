/**
 * CRC-16/MODBUS 校验和。
 *
 * 多项式: 0x8005 (x^16 + x^15 + x^2 + 1)
 * 初始值: 0xFFFF
 * 输出异或: 0x0000
 * 反射: 是（LSB 优先处理）
 *
 * 与 .NET ReplaySerializer.ComputeCRC16 完全一致，
 * 兼容 Python crcmod.mkCrcFun(0x18005, 0xFFFF, False, 0x0000)
 * 和 Node.js crc 包的 "crc16modbus" 模式。
 */

// 预计算 CRC16/MODBUS 查找表（以空间换时间）
const CRC16_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >>> 1) ^ 0xA001;
      } else {
        crc = crc >>> 1;
      }
    }
    table[i] = crc;
  }
  return table;
})();

/**
 * 计算 CRC16/MODBUS 校验和（查表实现，性能优）。
 * 测试向量: "123456789" → 0x4B37
 */
export function computeCRC16(
  data: Uint8Array,
  offset: number = 0,
  length: number = data.length
): number {
  let crc = 0xFFFF;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return crc & 0xFFFF;
}

/**
 * 逐位计算 CRC16/MODBUS。
 * 与 C# 原版逐位循环完全一致，用于交叉验证查表实现的正确性。
 */
export function computeCRC16Bitwise(
  data: Uint8Array,
  offset: number = 0,
  length: number = data.length
): number {
  let crc = 0xFFFF;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = ((crc >>> 1) ^ 0xA001) & 0xFFFF;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc & 0xFFFF;
}
