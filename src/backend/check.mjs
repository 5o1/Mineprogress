export function suggestBindings(boundItems, projectItems, {
  terminalStatuses = [],
  availableStatuses = [],
  maxSuggestions = 20
} = {}) {
  const byId = new Map(projectItems.map(item => [item.itemId, item]));
  const boundIds = new Set(boundItems.map(item => item.itemId));
  const suggestedRemove = [];
  for (const bound of boundItems) {
    const current = byId.get(bound.itemId);
    if (!current) suggestedRemove.push({ itemId: bound.itemId, title: bound.title, reason: 'Item is no longer in the configured Project.' });
    else if (current.archived) suggestedRemove.push({ itemId: current.itemId, title: current.title, reason: 'Item is archived.' });
    else if (terminalStatuses.includes(current.status)) suggestedRemove.push({ itemId: current.itemId, title: current.title, reason: `Item is in terminal status ${current.status}.` });
  }
  const active = new Set(availableStatuses.filter(status => !terminalStatuses.includes(status)));
  const suggestedAdd = projectItems
    .filter(item => !boundIds.has(item.itemId) && !item.archived && active.has(item.status))
    .slice(0, maxSuggestions)
    .map(item => ({ itemId: item.itemId, title: item.title, reason: `Active ${item.status} item is not bound to this thread.` }));
  return { suggestedAdd, suggestedRemove };
}
