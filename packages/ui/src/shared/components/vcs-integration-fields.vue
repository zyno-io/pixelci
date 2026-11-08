<template>
    <template v-if="platform === 'github'">
        <label>
            GitHub Enterprise URL (optional)
            <input class="input" v-model="config.url" type="url" placeholder="Leave blank for github.com" />
        </label>

        <label>
            App ID
            <input class="input" v-model="config.appId" type="text" required />
        </label>

        <label>
            Client ID
            <input class="input" v-model="config.clientId" type="text" required />
        </label>

        <label>
            Client Secret
            <input
                v-model="config.clientSecret"
                type="text"
                :placeholder="isEdit ? 'Leave blank to keep the current secret' : ''"
                :required="!isEdit"
            />
        </label>

        <label>
            Private Key
            <textarea class="input" v-model="config.privateKey" rows="4" placeholder="-----BEGIN RSA PRIVATE KEY-----" :required="!isEdit || !hasPrivateKey" />
            <span v-if="isEdit && hasPrivateKey" class="hint">Key configured. Leave blank to keep the stored key.</span>
        </label>

        <label>
            OIDC Audience
            <input class="input" v-model="config.oidcAudience" type="text" required />
            <span class="hint">Must equal PIXELCI_API_URL in your workflows.</span>
        </label>

        <div class="redirect-url">
            <span class="redirect-label">Callback URL</span>
            <code>{{ redirectUrl }}</code>
            <button type="button" class="btn copy-btn" @click="copyRedirectUrl"><i class="fa fa-copy" /> Copy</button>
            <p class="hint">
                Use this as the callback URL of your GitHub App. Permissions: Metadata read, Contents read, Actions read &amp; write (for CI re-runs),
                Pull requests read (optional). See
                <a href="https://docs.pixelci.dev/github-setup" target="_blank" rel="noopener">the GitHub setup guide</a>.
            </p>
        </div>
    </template>

    <template v-else>
        <label>
            GitLab URL
            <input class="input" v-model="config.url" type="url" placeholder="https://gitlab.example.com" required />
        </label>

        <label>
            Client ID
            <input class="input" v-model="config.clientId" type="text" required />
        </label>

        <label>
            Client Secret
            <input
                v-model="config.clientSecret"
                type="text"
                :placeholder="isEdit ? 'Leave blank to keep the current secret' : ''"
                :required="!isEdit"
            />
        </label>

        <div class="redirect-url">
            <span class="redirect-label">OAuth Redirect URI</span>
            <code>{{ redirectUrl }}</code>
            <button type="button" class="btn copy-btn" @click="copyRedirectUrl"><i class="fa fa-copy" /> Copy</button>
            <p class="hint">Use this URL as the redirect URI when configuring your GitLab OAuth application.</p>
        </div>
    </template>
</template>

<script lang="ts">
import type { IVcsIntegrationCreateInput, IVcsIntegrationUpdateInput } from '@/openapi-client-generated';

export interface IVcsConfigFormState {
    url: string;
    clientId: string;
    clientSecret: string;
    appId: string;
    privateKey: string;
    oidcAudience: string;
}

export function emptyVcsConfig(): IVcsConfigFormState {
    return {
        url: '',
        clientId: '',
        clientSecret: '',
        appId: '',
        privateKey: '',
        oidcAudience: window.location.origin
    };
}

export function buildVcsCreateBody(name: string, platform: 'gitlab' | 'github', cfg: IVcsConfigFormState): IVcsIntegrationCreateInput {
    if (platform === 'github') {
        return {
            name,
            platform,
            config: {
                ...(cfg.url.trim() ? { url: cfg.url.trim() } : {}),
                clientId: cfg.clientId,
                clientSecret: cfg.clientSecret,
                appId: cfg.appId,
                privateKey: cfg.privateKey,
                oidcAudience: cfg.oidcAudience
            }
        };
    }
    return { name, platform, config: { url: cfg.url, clientId: cfg.clientId, clientSecret: cfg.clientSecret } };
}

/** Always sends `platform`; blank secrets are sent as '' (server keeps the stored value); blank GitHub url clears it. */
export function buildVcsUpdateBody(name: string, platform: 'gitlab' | 'github', cfg: IVcsConfigFormState): IVcsIntegrationUpdateInput {
    if (platform === 'github') {
        return {
            name,
            platform,
            config: {
                url: cfg.url.trim(),
                clientId: cfg.clientId,
                clientSecret: cfg.clientSecret,
                appId: cfg.appId,
                privateKey: cfg.privateKey,
                oidcAudience: cfg.oidcAudience
            }
        };
    }
    return { name, platform, config: { url: cfg.url, clientId: cfg.clientId, clientSecret: cfg.clientSecret } };
}
</script>

<script lang="ts" setup>
import { computed } from 'vue';

defineProps<{
    platform: 'gitlab' | 'github';
    isEdit?: boolean;
    hasPrivateKey?: boolean;
}>();

const config = defineModel<IVcsConfigFormState>({ required: true });

const redirectUrl = computed(() => `${window.location.origin}/login`);

async function copyRedirectUrl() {
    await navigator.clipboard.writeText(redirectUrl.value);
}
</script>

<style lang="scss" scoped>
textarea.input {
    height: auto;
    min-height: 96px;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    resize: vertical;
}

.hint {
    color: var(--text-3);
    font-size: 12px;
    font-weight: 400;
}

.redirect-url {
    .copy-btn {
        align-self: flex-start;
    }
    a {
        color: var(--link);
        text-decoration: underline;
        text-underline-offset: 2px;
    }
}
</style>
