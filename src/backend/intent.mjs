const COMPLETION_PATTERNS = [
  /(?:the\s+)?(?:current\s+)?(?:project|task|todo|work)\s+(?:is|has been|is now)\s+(?:complete|completed|done|finished|ended)\b/iu,
  /\b(?:complete|finish|close)\s+(?:this|the|current)\s+(?:project|task|todo)\b/iu,
  /(?:当前|这个|本次)?(?:项目|任务|待办|todo).{0,12}(?:已经|已|现在)?(?:完成|结束|完结)了?/iu,
  /(?:完成|结束|完结)了?.{0,8}(?:当前|这个|本次)?(?:项目|任务|待办|todo)/iu
];

const FUTURE_OR_CONDITIONAL = [
  /\b(?:will|would|should|could|may|might|when|after|before|if)\b.{0,24}\b(?:complete|completed|done|finish|finished|end|ended)\b/iu,
  /(?:将会|将|会|应该|需要|准备|计划|等到|如果|之后|以前|之前).{0,24}(?:完成|结束|完结)/iu
];

export function isCompletionDeclaration(text) {
  const normalized = String(text || '').trim();
  if (!normalized || FUTURE_OR_CONDITIONAL.some(pattern => pattern.test(normalized))) return false;
  return COMPLETION_PATTERNS.some(pattern => pattern.test(normalized));
}
