export const INTERACTIVE_CHAT_ONLY_MAX = 85;
export const INTERACTIVE_WORKSPACE_MIN = 196;
export const INTERACTIVE_LEFT_MIN = 34;
export const INTERACTIVE_LEFT_MAX = 44;
export const INTERACTIVE_RIGHT_MIN = 32;
export const INTERACTIVE_RIGHT_MAX = 42;

export function resolveInteractiveLayout({ width = 100, height = 34, inputHeight = 4, overlayHeight = 0 } = {}) {
  const safeWidth = Math.max(40, Number(width) || 100);
  const safeHeight = Math.max(18, Number(height) || 34);
  const mode = safeWidth <= INTERACTIVE_CHAT_ONLY_MAX
    ? 'chat'
    : safeWidth >= INTERACTIVE_WORKSPACE_MIN
      ? 'workspace'
      : 'sidebar';
  const headerHeight = 4;
  const footerHeight = 1;
  const resolvedInputHeight = Number(inputHeight) === 0 ? 0 : Math.max(3, Number(inputHeight) || 4);
  const mainHeight = Math.max(
    5,
    safeHeight
      - headerHeight
      - Math.max(0, Number(overlayHeight) || 0)
      - resolvedInputHeight
      - footerHeight,
  );

  if (mode === 'chat') {
    return {
      mode,
      width: safeWidth,
      height: safeHeight,
      headerHeight,
      footerHeight,
      mainHeight,
      chatWidth: safeWidth,
      leftWidth: 0,
      rightWidth: 0,
      inputWidth: safeWidth,
    };
  }

  if (mode === 'sidebar') {
    const leftWidth = clamp(Math.round(safeWidth * 0.3), INTERACTIVE_LEFT_MIN, INTERACTIVE_LEFT_MAX);
    const chatWidth = Math.max(40, safeWidth - leftWidth - 1);
    return {
      mode,
      width: safeWidth,
      height: safeHeight,
      headerHeight,
      footerHeight,
      mainHeight,
      chatWidth,
      leftWidth,
      rightWidth: 0,
      inputWidth: safeWidth,
    };
  }

  const leftWidth = clamp(Math.round(safeWidth * 0.19), INTERACTIVE_LEFT_MIN, INTERACTIVE_LEFT_MAX);
  const rightWidth = clamp(Math.round(safeWidth * 0.21), INTERACTIVE_RIGHT_MIN, INTERACTIVE_RIGHT_MAX);
  const chatWidth = Math.max(48, safeWidth - leftWidth - rightWidth - 2);
  return {
    mode,
    width: safeWidth,
    height: safeHeight,
    headerHeight,
    footerHeight,
    mainHeight,
    chatWidth,
    leftWidth,
    rightWidth,
    inputWidth: safeWidth,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
