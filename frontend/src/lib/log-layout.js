// Prefix offsets use measured row heights; IDs keep a reading position stable when
// the bounded log buffer drops old rows. A rebuild is bounded by the 5000-row cap.
export function buildLogLayout(lines, heights, estimate = 26.25) {
  const ids = [], offsets = [0], indices = new Map();
  for (const line of lines) {
    indices.set(line.id, ids.length);
    ids.push(line.id);
    offsets.push(offsets.at(-1) + (heights.get(line.id) || estimate));
  }
  return { ids, offsets, indices, total: offsets.at(-1) };
}

export function logIndexAt(layout, offset) {
  let lo = 0, hi = layout.ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (layout.offsets[mid + 1] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, layout.ids.length - 1));
}

export function captureLogAnchor(layout, scrollTop) {
  if (!layout.ids.length) return null;
  const index = logIndexAt(layout, scrollTop);
  return { id: layout.ids[index], inset: scrollTop - layout.offsets[index] };
}

export function restoreLogAnchor(layout, anchor) {
  const index = layout.indices.get(anchor?.id);
  if (index == null) return 0;
  const height = layout.offsets[index + 1] - layout.offsets[index];
  return layout.offsets[index] + Math.min(anchor.inset, Math.max(0, height - 1));
}
