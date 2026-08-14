// In-process registry mapping a Proposal `type` to its action-execution
// function (Phase 7 onward: `send-outreach` -> lib/actions/sendOutreach.js,
// etc.). decide.js consults this so that approving a level-2 proposal can
// immediately trigger execution, and confirmAndExecute can look up the
// action for a level-3/4 proposal - without decide.js needing to know about
// any specific action module. Every registered function is still expected to
// call `assertProposalAuthorized` itself (lib/authority/policy.js) as its own
// first line, so the guard holds even if something calls it directly.
const registry = new Map();

export function registerActionExecutor(type, executor) {
  if (typeof type !== 'string' || type.trim() === '') {
    throw new Error('registerActionExecutor requires a non-empty action type');
  }
  if (typeof executor !== 'function') {
    throw new Error('registerActionExecutor requires a function');
  }
  registry.set(type, executor);
}

export function getActionExecutor(type) {
  return registry.get(type) ?? null;
}

export function clearActionExecutor(type) {
  registry.delete(type);
}

export function listRegisteredActionTypes() {
  return [...registry.keys()];
}
