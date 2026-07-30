function buildPrompt(width, height) {
  return `You are a UI screenshot analyst extracting layout data for a Figma import pipeline. Precision matters more than completeness — a wrong coordinate breaks the import.

Image size: ${width}x${height}px. Origin (0,0) is top-left.

TASK: List every visible box (rectangle/card/button/container) and every distinct text block as flat nodes.

MUST:
- x,y = top-left corner, measured in absolute pixels against the ${width}x${height} frame you were told — not eyeballed proportionally
- parentId = the id of the immediate visual container only, never a distant ancestor. Top-level nodes: parentId = null
- fill/stroke/color = hex string of the dominant color in that region
- name = semantic role, e.g. "Button / Submit", "Card / Product 1", "Text / Title" — never "Rectangle 1" or "div"

NEVER:
- invent a node that is not visible in the image
- guess a color when the region is transparent or unclear — use null instead
- skip a node because you are unsure of its exact bounds — estimate it

If a value is genuinely unknown, use null. Do not leave required fields empty strings as a substitute.`;
}

module.exports = { buildPrompt };
