export const INTERACTIVE_NARROW_MAX = 85;
export const INTERACTIVE_WIDE_MIN = 138;
export const INTERACTIVE_CHAT_MAX = 96;
export const INTERACTIVE_CHAT_MIN = 56;

export function resolveInteractiveLayout({ width = 100, height = 34, inputHeight = 4, overlayHeight = 0 } = {}) {
  const safeWidth = Math.max(40, Number(width) || 100);
  const safeHeight = Math.max(18, Number(height) || 34);
  const mode = safeWidth <= INTERACTIVE_NARROW_MAX ? 'narrow' : safeWidth >= INTERACTIVE_WIDE_MIN ? 'wide' : 'centered';
  const headerHeight = 4;
  const footerHeight = 1;
  const mainHeight = Math.max(5, safeHeight - headerHeight - Math.max(0, Number(overlayHeight) || 0) - Math.max(3, Number(inputHeight) || 4) - footerHeight);

  if (mode === 'wide') {
    const chatWidth = Math.min(INTERACTIVE_CHAT_MAX, Math.max(76, Math.floor(safeWidth * 0.56)));
    const remaining = Math.max(0, safeWidth - chatWidth - 2);
    const leftWidth = Math.floor(remaining / 2);
    const rightWidth = remaining - leftWidth;
    return { mode, width: safeWidth, height: safeHeight, headerHeight, footerHeight, mainHeight, chatWidth, leftWidth, rightWidth, inputWidth: chatWidth };
  }

  if (mode === 'centered') {
    const chatWidth = Math.min(INTERACTIVE_CHAT_MAX, Math.max(INTERACTIVE_CHAT_MIN, safeWidth - 8));
    const remaining = Math.max(0, safeWidth - chatWidth);
    const leftWidth = Math.floor(remaining / 2);
    const rightWidth = remaining - leftWidth;
    return { mode, width: safeWidth, height: safeHeight, headerHeight, footerHeight, mainHeight, chatWidth, leftWidth, rightWidth, inputWidth: chatWidth };
  }

  return { mode, width: safeWidth, height: safeHeight, headerHeight, footerHeight, mainHeight, chatWidth: safeWidth, leftWidth: 0, rightWidth: 0, inputWidth: safeWidth };
}
