/**
 * 值班窗口标识：一个浏览器标签页 = 一个值班窗口。
 * sessionStorage 保证不同标签页各自独立（复制链接打开的标签也会重新分配），
 * 同标签页刷新后仍视为同一个窗口。
 */
const KEY = 'gbfishport:window-id';

export function currentWindowId(): string {
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // sessionStorage 不可用时退化为一次性标识
    return `w-${Math.random().toString(36).slice(2, 8)}`;
  }
}
