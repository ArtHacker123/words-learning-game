/** FNV-1a 双哈希,生成稳定的 16 位十六进制 wordId */
export default function wordHash(foreign: string, chinese: string): string {
  const bytes = new TextEncoder().encode(`${foreign}::${chinese}`);
  let h1 = 2166136261 >>> 0;
  let h2 = 2246822519 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= bytes[i];
    h2 = Math.imul(h2, 16777619) >>> 0;
    h2 = Math.imul(h2, 2654435761) >>> 0; // 打散第二个通道
  }
  // 融合两通道
  h1 = Math.imul(h1 ^ (h2 >>> 15), 0x85ebca6b) >>> 0;
  h1 ^= h1 >>> 13;
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}