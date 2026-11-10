/** Only the isolated approval window receives this payload. */
export interface BridgeApprovalPrompt {
  id: string;
  title: string;
  detail: string;
  dark: boolean;
}

export interface BridgeApprovalWindowApi {
  read(): Promise<BridgeApprovalPrompt>;
  decide(id: string, approved: boolean): Promise<void>;
}

export const BRIDGE_APPROVAL_CANCELLED = 'Bridge change cancelled.';
