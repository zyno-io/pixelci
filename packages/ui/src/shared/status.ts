/** Tones, icons and wording for build and screen statuses, shared by every screen that shows one. */
export interface IStatusTag {
    label: string;
    tone: string;
    icon?: string;
}

export type BuildStatus = 'draft' | 'processing' | 'no changes' | 'needs review' | 'changes approved' | 'changes rejected' | 'canceled' | 'failed';

export const BUILD_STATUS: Record<BuildStatus, IStatusTag> = {
    'needs review': { label: 'Needs Review', tone: 'warning', icon: 'fa-magnifying-glass' },
    processing: { label: 'Processing', tone: 'warning', icon: 'fa-stopwatch' },
    'no changes': { label: 'No Changes', tone: 'info', icon: 'fa-check' },
    'changes approved': { label: 'Changes Approved', tone: 'success', icon: 'fa-check' },
    'changes rejected': { label: 'Changes Rejected', tone: 'danger', icon: 'fa-xmark' },
    failed: { label: 'Failed', tone: 'danger', icon: 'fa-xmark' },
    draft: { label: 'Draft', tone: '', icon: 'fa-pen-to-square' },
    canceled: { label: 'Canceled', tone: '' }
};

export const SCREEN_STATUS: Record<string, IStatusTag> = {
    new: { label: 'New', tone: 'release' },
    'needs review': { label: 'Needs Review', tone: 'warning' },
    'no changes': { label: 'No Changes', tone: 'info' },
    'changes approved': { label: 'Changes Approved', tone: 'success' }
};

export const REMOVED_STATUS: IStatusTag = { label: 'Removed', tone: '' };

export const REVIEW_STATUS: Record<'approved' | 'rejected', IStatusTag> = {
    approved: { label: 'Approved', tone: 'success', icon: 'fa-check' },
    rejected: { label: 'Rejected', tone: 'danger', icon: 'fa-xmark' }
};
