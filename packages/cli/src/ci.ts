import { getApiUrl } from './api.js';
import { getGitHubCiInfo } from './ci-github.js';
import { getGitLabCiInfo } from './ci-gitlab.js';

export interface ICIJobInfo {
    projectUrl: string;
    ciToken: string;
}

export async function getJobInfo(): Promise<ICIJobInfo | null> {
    const gitlabInfo = getGitLabCiInfo();
    if (gitlabInfo) {
        return gitlabInfo;
    }

    if (process.env.GITHUB_ACTIONS === 'true') {
        return getGitHubCiInfo(getApiUrl());
    }

    return null;
}
