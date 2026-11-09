import { assert, type ReceiveType } from '@zyno-io/ts-reflection';
import { openAsBlob } from 'fs';

import { ICIJobInfo } from './ci.js';
import { AppError } from './error.js';

export type IBuildStatus = 'draft' | 'processing' | 'no changes' | 'needs review' | 'changes approved' | 'changes rejected' | 'failed';

export function getApiUrl(): string {
    const apiUrl = process.env.PIXELCI_API_URL;
    if (!apiUrl) {
        throw new AppError('PIXELCI_API_URL environment variable is not set');
    }
    return apiUrl.replace(/\/+$/, '');
}

export function getApi(jobInfo: ICIJobInfo): PixelCiApi {
    const apiUrl = getApiUrl();

    const appId = process.env.PIXELCI_APP_ID;
    if (!appId) {
        throw new AppError('PIXELCI_APP_ID environment variable is not set');
    }

    return new PixelCiApi(apiUrl, appId, jobInfo);
}

export class PixelCiApi {
    private serverUrl: string;
    private appId: string;
    private ciToken: string;
    private projectUrl: string;

    constructor(serverUrl: string, appId: string, jobInfo: ICIJobInfo) {
        this.serverUrl = serverUrl.replace(/\/+$/, '');
        this.appId = appId;
        this.ciToken = jobInfo.ciToken;
        this.projectUrl = jobInfo.projectUrl;
    }

    private async sendApiRequest<T>(method: string, path: string, body?: Record<string, unknown> | FormData, type?: ReceiveType<T>): Promise<T> {
        const isJsonBody = body && !(body instanceof FormData);
        const response = await fetch(`${this.serverUrl}/api/${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.ciToken}`,
                ...(isJsonBody && { 'Content-Type': 'application/json' })
            },
            body: isJsonBody ? JSON.stringify(body) : body
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new AppError(`API request failed: ${response.statusText} | ${errorText}`);
        }

        const data = await response.json();
        assert<T>(data, undefined, type);

        return data;
    }

    getBuildUserUrl(buildId: string): string {
        return `${this.serverUrl}/apps/${this.appId}/builds/${buildId}`;
    }

    async createBuild(): Promise<{ buildId: string; status: IBuildStatus }> {
        const response = await this.sendApiRequest<{ id: string; status: IBuildStatus }>('POST', `apps/${this.appId}/builds`, {
            projectUrl: this.projectUrl
        });

        return {
            buildId: response.id,
            status: response.status
        };
    }

    async uploadScreen(buildId: string, imageFile: string, screenName: string): Promise<void> {
        const blob = await openAsBlob(imageFile, { type: 'image/png' });
        const formData = new FormData();
        formData.append('image', blob, `${screenName}.png`);
        await this.sendApiRequest<{ id: string }>('POST', `apps/${this.appId}/builds/${buildId}/screens`, formData);
    }

    async processBuild(buildId: string): Promise<void> {
        await this.sendApiRequest<{ ok: true }>('POST', `apps/${this.appId}/builds/${buildId}/process`);
    }

    async getBuildStatus(buildId: string): Promise<IBuildStatus> {
        const response = await this.sendApiRequest<{ status: IBuildStatus }>('GET', `apps/${this.appId}/builds/${buildId}/status`);
        return response.status;
    }
}
