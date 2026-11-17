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

/** Where a build's reference came from. Only `ancestor` and `latest` get a header chip or notice; the rest stay silent. */
export const REFERENCE_SOURCE_NOTE: Record<string, string> = {
    ancestor: 'The approved default-branch build at the point where this build forked from the default branch.',
    latest: 'The latest approved default-branch build. PixelCI could not find where this build forked.'
};

export const REFERENCE_FALLBACK_NOTICE =
    "PixelCI couldn't find where this build's history meets the default branch, so it compared against the latest approved build there. " +
    'Changes made on the default branch since may appear here. Fetch full history in CI to fix this.';
export const REFERENCE_FALLBACK_DOCS_URL = 'https://docs.pixelci.dev/usage#how-the-baseline-is-chosen';

export const REVOKE_CONFIRM_TITLE = 'Revoke this approval?';
export const REVOKE_CONFIRM_MESSAGE = 'Future builds that make this change will ask again. Builds already approved stay approved.';
export const REVOKE_CONFIRM_LABEL = 'Revoke approval';
