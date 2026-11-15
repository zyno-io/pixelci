<template>
    <div id="oauth-error" class="auth-page">
        <div class="theme-corner"><ThemeMenu /></div>
        <div class="card auth-card">
            <span class="auth-mark" aria-hidden="true"><i class="fa-solid fa-border-all" /></span>
            <h1>Couldn't connect the app</h1>

            <div class="notice danger" role="alert">
                <i class="fa-solid fa-circle-exclamation" aria-hidden="true" />
                <div class="notice-body" data-testid="oauth-error-message">{{ message }}</div>
            </div>

            <p class="subtitle">Nothing was shared with the app. Go back to it and try connecting again.</p>
            <RouterLink to="/" class="btn">Go to PixelCI</RouterLink>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import ThemeMenu from '@/shared/components/theme-menu.vue';

// Fixed messages only: the reason comes from the URL, so it selects text and is never displayed itself.
const MESSAGES: Record<string, string> = {
    invalid_client: "This app isn't registered with this PixelCI server. Remove it from your MCP client and add it again.",
    invalid_redirect_uri:
        "The address this app asked to send you back to doesn't match what it registered, so we stopped before sending it anything.",
    invalid_request: 'The connection request was malformed or incomplete.',
    rate_limited: 'There have been too many connection attempts. Wait a few minutes and try again.',
    disabled: "Connecting apps with OAuth isn't turned on for this PixelCI server."
};

const route = useRoute();

const message = computed(() => {
    const reason = typeof route.query.reason === 'string' ? route.query.reason : '';
    return Object.prototype.hasOwnProperty.call(MESSAGES, reason) ? MESSAGES[reason] : 'The connection request could not be completed.';
});
</script>
