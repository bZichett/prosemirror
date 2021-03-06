const {findDiffStart, findDiffEnd, Mark} = require("../model")
const {fromDOM} = require("../htmlformat")
const {mapThroughResult} = require("../transform/map")

const {findSelectionFrom, selectionFromDOM} = require("./selection")
const {DOMFromPos} = require("./dompos")

function readInputChange(pm) {
  pm.ensureOperation({readSelection: false})
  return readDOMChange(pm, rangeAroundSelection(pm))
}
exports.readInputChange = readInputChange

function readCompositionChange(pm, margin) {
  return readDOMChange(pm, rangeAroundComposition(pm, margin))
}
exports.readCompositionChange = readCompositionChange

// Note that all referencing and parsing is done with the
// start-of-operation selection and document, since that's the one
// that the DOM represents. If any changes came in in the meantime,
// the modification is mapped over those before it is applied, in
// readDOMChange.

function parseBetween(pm, from, to) {
  let {node: parent, offset: startOff} = DOMFromPos(pm, from, true)
  let endOff = DOMFromPos(pm, to, true).offset
  while (startOff) {
    let prev = parent.childNodes[startOff - 1]
    if (prev.nodeType != 1 || !prev.hasAttribute("pm-offset")) --startOff
    else break
  }
  while (endOff < parent.childNodes.length) {
    let next = parent.childNodes[endOff]
    if (next.nodeType != 1 || !next.hasAttribute("pm-offset")) ++endOff
    else break
  }
  return fromDOM(pm.schema, parent, {
    topNode: pm.doc.resolve(from).parent.copy(),
    from: startOff,
    to: endOff,
    preserveWhitespace: true,
    editableContent: true
  })
}

function isAtEnd($pos, depth) {
  for (let i = depth || 0; i < $pos.depth; i++)
    if ($pos.index(i) + 1 < $pos.node(i).childCount) return false
  return $pos.parentOffset == $pos.parent.content.size
}
function isAtStart($pos, depth) {
  for (let i = depth || 0; i < $pos.depth; i++)
    if ($pos.index(0) > 0) return false
  return $pos.parentOffset == 0
}

function rangeAroundSelection(pm) {
  let {$from, $to} = pm.operation.sel
  // When the selection is entirely inside a text block, use
  // rangeAroundComposition to get a narrow range.
  if ($from.sameParent($to) && $from.parent.isTextblock && $from.parentOffset && $to.parentOffset < $to.parent.content.size)
    return rangeAroundComposition(pm, 0)

  for (let depth = 0;; depth++) {
    let fromStart = isAtStart($from, depth + 1), toEnd = isAtEnd($to, depth + 1)
    if (fromStart || toEnd || $from.index(depth) != $to.index(depth) || $to.node(depth).isTextblock) {
      let from = $from.before(depth + 1), to = $to.after(depth + 1)
      if (fromStart && $from.index(depth) > 0)
        from -= $from.node(depth).child($from.index(depth) - 1).nodeSize
      if (toEnd && $to.index(depth) + 1 < $to.node(depth).childCount)
        to += $to.node(depth).child($to.index(depth) + 1).nodeSize
      return {from, to}
    }
  }
}

function rangeAroundComposition(pm, margin) {
  let {$from, $to} = pm.operation.sel
  if (!$from.sameParent($to)) return rangeAroundSelection(pm)
  let startOff = Math.max(0, $from.parentOffset - margin)
  let size = $from.parent.content.size
  let endOff = Math.min(size, $to.parentOffset + margin)

  if (startOff > 0)
    startOff = $from.parent.childBefore(startOff).offset
  if (endOff < size) {
    let after = $from.parent.childAfter(endOff)
    endOff = after.offset + after.node.nodeSize
  }
  let nodeStart = $from.start()
  return {from: nodeStart + startOff, to: nodeStart + endOff}
}

function readDOMChange(pm, range) {
  let op = pm.operation
  // If the document was reset since the start of the current
  // operation, we can't do anything useful with the change to the
  // DOM, so we discard it.
  if (op.docSet) {
    pm.markAllDirty()
    return false
  }

  let parsed = parseBetween(pm, range.from, range.to)
  let compare = op.doc.slice(range.from, range.to)
  let change = findDiff(compare.content, parsed.content, range.from, op.sel.from)
  if (!change) return false
  let fromMapped = mapThroughResult(op.mappings, change.start)
  let toMapped = mapThroughResult(op.mappings, change.endA)
  if (fromMapped.deleted && toMapped.deleted) return false

  // Mark nodes touched by this change as 'to be redrawn'
  markDirtyFor(pm, op.doc, change.start, change.endA)

  let $from = parsed.resolveNoCache(change.start - range.from)
  let $to = parsed.resolveNoCache(change.endB - range.from), nextSel, text
  // If this looks like the effect of pressing Enter, just dispatch an
  // Enter key instead.
  if (!$from.sameParent($to) && $from.pos < parsed.content.size &&
      (nextSel = findSelectionFrom(parsed.resolve($from.pos + 1), 1, true)) &&
      nextSel.head == $to.pos) {
    pm.input.dispatchKey("Enter")
  } else if ($from.sameParent($to) && $from.parent.isTextblock &&
             (text = uniformTextBetween(parsed, $from.pos, $to.pos)) != null) {
    pm.input.insertText(fromMapped.pos, toMapped.pos, text, doc => domSel(pm, doc))
  } else {
    let slice = parsed.slice(change.start - range.from, change.endB - range.from)
    let tr = pm.tr.replace(fromMapped.pos, toMapped.pos, slice)
    tr.setSelection(domSel(pm, tr.doc))
    tr.applyAndScroll()
  }
  return true
}

function domSel(pm, doc) {
  if (pm.hasFocus()) return selectionFromDOM(pm, doc, null, true).range
}

function uniformTextBetween(node, from, to) {
  let result = "", valid = true, marks = null
  node.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline && pos < from) return
    if (!node.isText) return valid = false
    if (!marks) marks = node.marks
    else if (!Mark.sameSet(marks, node.marks)) valid = false
    result += node.text.slice(Math.max(0, from - pos), to - pos)
  })
  return valid ? result : null
}

function findDiff(a, b, pos, preferedStart) {
  let start = findDiffStart(a, b, pos)
  if (!start) return null
  let {a: endA, b: endB} = findDiffEnd(a, b, pos + a.size, pos + b.size)
  if (endA < start) {
    let move = preferedStart <= start && preferedStart >= endA ? start - preferedStart : 0
    start -= move
    endB = start + (endB - endA)
    endA = start
  } else if (endB < start) {
    let move = preferedStart <= start && preferedStart >= endB ? start - preferedStart : 0
    start -= move
    endA = start + (endA - endB)
    endB = start
  }
  return {start, endA, endB}
}

function markDirtyFor(pm, doc, start, end) {
  let $start = doc.resolve(start), $end = doc.resolve(end), same = $start.sameDepth($end)
  if (same == 0)
    pm.markAllDirty()
  else
    pm.markRangeDirty($start.before(same), $start.after(same), doc)
}
