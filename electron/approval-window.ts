/**
 * @deprecated Renamed to `notification-window.ts` — the dedicated pop-out window
 * now renders any notification-tab item (tool approvals, questions, alerts), not
 * just approvals. This module re-exports the back-compat approval-named API for
 * one release; new code should import from `./notification-window.js`.
 */
export {
  openApprovalWindow,
  closeApprovalWindow,
  closeAllApprovalWindows,
  hasApprovalWindow,
  registerApprovalWindowIpc,
  type ApprovalWindowRequest,
} from './notification-window.js';
