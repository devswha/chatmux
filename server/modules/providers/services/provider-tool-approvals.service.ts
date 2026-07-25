type GjcApprovalDecision = { allow: boolean; updatedInput?: unknown; message?: string; rememberEntry?: unknown };

type ProviderToolApprovalDependencies = {
    resolveToolApproval(requestId: string, decision: GjcApprovalDecision): void;
    getPendingApprovalsForSession(sessionId: string): unknown[];
    resolveGjcToolApproval(requestId: string, decision: GjcApprovalDecision): boolean;
    getPendingGjcApprovalsForSession(sessionId: string): unknown[];
};

export function createProviderToolApprovals({
    resolveToolApproval,
    getPendingApprovalsForSession,
    resolveGjcToolApproval,
    getPendingGjcApprovalsForSession,
}: ProviderToolApprovalDependencies) {
    return {
        resolveProviderToolApproval(requestId: string, decision: GjcApprovalDecision): void {
            if (!resolveGjcToolApproval(requestId, decision)) {
                resolveToolApproval(requestId, decision);
            }
        },

        getPendingProviderApprovalsForSession(sessionId: string) {
            return [
                ...getPendingApprovalsForSession(sessionId),
                ...getPendingGjcApprovalsForSession(sessionId),
            ];
        },
    };
}
