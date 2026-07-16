import {
  clampScrollOffset,
  isScrollAtBottom,
  resolveAutoScrollOffset,
  resolveScrollKeyOffset,
  scrollMax,
} from 'terlio.js';

export function createTranscriptScrollState() {
  return {
    scroll: 0,
    sticky: true,
    totalRows: 0,
    previousTotalRows: 0,
    visibleRows: 1,
  };
}

export function resolveTranscriptScroll(state = {}, { totalRows = 0, visibleRows = 1 } = {}) {
  const safeTotal = Math.max(0, Number(totalRows) || 0);
  const safeVisible = Math.max(1, Number(visibleRows) || 1);
  const previousTotalRows = Math.max(0, Number(state.totalRows ?? state.previousTotalRows) || 0);
  const scroll = resolveAutoScrollOffset({
    scroll: state.scroll,
    totalRows: safeTotal,
    previousTotalRows,
    visibleRows: safeVisible,
    sticky: state.sticky,
  });
  return {
    scroll,
    sticky: Boolean(state.sticky) && isScrollAtBottom(scroll, safeTotal, safeVisible),
    totalRows: safeTotal,
    previousTotalRows: safeTotal,
    visibleRows: safeVisible,
    maxScroll: scrollMax(safeTotal, safeVisible),
    atBottom: isScrollAtBottom(scroll, safeTotal, safeVisible),
  };
}

export function scrollTranscript(state = {}, keyName, { lineStep = 2 } = {}) {
  const result = resolveScrollKeyOffset({
    keyName,
    scroll: state.scroll,
    totalRows: state.totalRows,
    previousTotalRows: state.totalRows,
    visibleRows: state.visibleRows,
    sticky: false,
    includeHomeEnd: true,
    lineStep,
    pageStep: Math.max(1, (Number(state.visibleRows) || 1) - 2),
  });
  if (!result.handled) return { ...state, handled: false };
  return {
    ...state,
    scroll: result.scroll,
    sticky: result.atBottom,
    maxScroll: result.maxScroll,
    atBottom: result.atBottom,
    handled: true,
  };
}

export function followTranscript(state = {}) {
  const max = scrollMax(state.totalRows, state.visibleRows);
  return {
    ...state,
    scroll: max,
    sticky: true,
    maxScroll: max,
    atBottom: true,
  };
}

export function resetTranscriptScroll() {
  return createTranscriptScrollState();
}

export function transcriptScrollLabel(state = {}) {
  const total = Math.max(0, Number(state.totalRows) || 0);
  const visible = Math.max(1, Number(state.visibleRows) || 1);
  const max = scrollMax(total, visible);
  const scroll = clampScrollOffset(state.scroll, max);
  if (!max) return 'all messages visible';
  const above = scroll;
  const below = Math.max(0, max - scroll);
  if (!below) return `${above} lines above · following`;
  if (!above) return `${below} lines below`;
  return `${above} above · ${below} below`;
}

export function scrollbarForWindow({ totalRows = 0, visibleRows = 1, scroll = 0 } = {}) {
  const total = Math.max(0, Number(totalRows) || 0);
  const visible = Math.max(1, Number(visibleRows) || 1);
  if (total <= visible) return Array.from({ length: visible }, () => ' ');
  const max = scrollMax(total, visible);
  const safeScroll = clampScrollOffset(scroll, max);
  const thumbSize = Math.max(1, Math.min(visible, Math.round((visible * visible) / total)));
  const travel = Math.max(0, visible - thumbSize);
  const start = max ? Math.round((safeScroll / max) * travel) : 0;
  return Array.from({ length: visible }, (_, index) => index >= start && index < start + thumbSize ? '█' : '│');
}
