import { getApiUrl } from './api.js';
import { getGitHubCiInfo } from './ci-github.js';
import { getGitLabCiInfo } from './ci-gitlab.js';

export interface ICIJobInfo {
    projectUrl: string;
    ciToken: string;
    /** Display-only commit details, sent when the token (a GitLab ID token) carries none. */
    commit?: { subject?: string; author?: string };
}

export async function getJobInfo(): Promise<ICIJobInfo | null> {
    const gitlabInfo = getGitLabCiInfo(process.env, process.env.PIXELCI_API_URL);
    if (gitlabInfo) {
        return gitlabInfo;
    }

    if (process.env.GITHUB_ACTIONS === 'true') {
        return getGitHubCiInfo(getApiUrl());
    }

    return null;
}
