/**
 * Dual-key message dedupe for WebChat UI.
 * Episode id and text:role:content are tracked independently so
 * local send (no id) and tail-sync/poll (with id) do not duplicate DOM nodes.
 */
export function createMessageDedupe() {
  const seenKeys = new Set();

  function idKey(id) {
    return `id:${id}`;
  }

  function textKey(role, text) {
    return `text:${role}:${text}`;
  }

  return {
    isDuplicate(role, text, id) {
      if (id !== undefined && seenKeys.has(idKey(id))) return true;
      if (seenKeys.has(textKey(role, text))) return true;
      return false;
    },

    remember(role, text, id) {
      if (id !== undefined) seenKeys.add(idKey(id));
      seenKeys.add(textKey(role, text));
    },

    clear() {
      seenKeys.clear();
    },
  };
}
