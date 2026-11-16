<template>
    <div id="oauth-consent" class="auth-page">
        <div class="theme-corner"><ThemeMenu /></div>
        <div class="card auth-card consent-card">
            <span class="auth-mark" aria-hidden="true"><i class="fa-solid fa-border-all" /></span>

            <!-- Clickjacking guard: an approval screen must never be operable from inside another page. -->
            <template v-if="phase === 'framed'">
                <h1>This screen can't be shown here</h1>
                <p class="subtitle">For your security, access requests can only be approved in their own tab.</p>
                <a class="btn primary lg" :href="selfUrl" target="_blank" rel="noopener noreferrer">
                    <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" /> Open in its own tab
                </a>
            </template>

            <div v-else-if="phase === 'loading'" class="consent-loading" role="status">
                <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true" />
                <span>Loading request…</span>
            </div>

            <template v-else-if="phase === 'ready' && request">
                <h1 class="consent-title" data-testid="consent-title">
                    Allow <span class="client-name">{{ request.clientName }}</span>
                    <template v-if="request.verification === 'verified_domain' && request.clientIdHost">
                        from <span class="client-name" data-testid="consent-client-host">{{ request.clientIdHost }}</span>
                    </template>
                    read-only access to PixelCI?
                </h1>

                <p v-if="request.verification === 'verified_domain'" class="unverified" data-testid="consent-verification">
                    <span class="tag success"><i class="fa-solid fa-globe" aria-hidden="true" /> Verified domain: {{ request.clientIdHost }}</span>
                    <span class="hint">
                        PixelCI loaded this app's details from {{ request.clientIdHost }}. The app chose its own name; continue only if you recognise
                        {{ request.clientIdHost }} and just started this connection.
                    </span>
                </p>
                <p v-else class="unverified" data-testid="consent-verification">
                    <span class="tag warning"><i class="fa-solid fa-circle-question" aria-hidden="true" /> Unverified app</span>
                    <span v-if="request.verification === 'claimed_domain' && request.redirectKind === 'loopback'" class="hint">
                        It says it's published by {{ request.clientIdHost }}, but it returns to an app on this computer, so any program here could
                        make that claim. Continue only if you just started this connection.
                    </span>
                    <span v-else-if="request.verification === 'claimed_domain'" class="hint">
                        Its details are hosted on {{ request.clientIdHost }}, a shared hosting service where anyone can publish. Continue only if you
                        just started this connection.
                    </span>
                    <span v-else class="hint">Anyone can register an app under any name. Continue only if you just started this connection.</span>
                </p>

                <div class="notice return-to" data-testid="consent-redirect">
                    <i class="fa-solid fa-arrow-right" aria-hidden="true" />
                    <div class="notice-body">You'll be returned to <strong>{{ request.redirectDisplay }}</strong></div>
                </div>

                <p v-if="request.redirectOffDomain" class="notice warning" role="note" data-testid="consent-off-domain">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true" />
                    <span class="notice-body">
                        It returns you to {{ request.redirectDisplay }}, a different site from {{ request.clientIdHost }}.
                    </span>
                </p>

                <ul class="abilities">
                    <li>
                        <i class="fa-solid fa-check" aria-hidden="true" />
                        <span>Can read apps, builds, review decisions, comments and screenshots <strong>you</strong> can access</span>
                    </li>
                    <li>
                        <i class="fa-solid fa-xmark" aria-hidden="true" />
                        <span>Cannot approve, reject or comment</span>
                    </li>
                </ul>

                <p class="signed-in">
                    Signed in as <strong data-testid="consent-user">{{ store.sessionUser?.name }}</strong>. Not you?
                    <button type="button" class="link-btn" data-testid="consent-switch" @click="switchAccount">Switch account</button>
                </p>

                <p v-if="errorMessage" class="notice danger" role="alert">
                    <i class="fa-solid fa-circle-exclamation" aria-hidden="true" />
                    <span class="notice-body">{{ errorMessage }}</span>
                </p>

                <div class="actions">
                    <button type="button" class="btn lg" data-testid="consent-deny" :disabled="busy" @click="decide('deny')">Deny</button>
                    <button type="button" class="btn primary lg" data-testid="consent-allow" :disabled="busy || !armed" @click="decide('approve')">
                        Allow
                    </button>
                </div>

                <p class="hint revoke-hint">You can revoke access any time in <RouterLink to="/connected-apps">Connected apps</RouterLink>.</p>
            </template>

            <template v-else-if="phase === 'returning'">
                <h1>Returning you to {{ request?.clientName }}…</h1>
                <p class="subtitle" role="status">You can close this tab once the app confirms it's connected.</p>
            </template>

            <template v-else>
                <h1>{{ endedTitle }}</h1>
                <p class="subtitle" role="alert" data-testid="consent-ended">{{ endedMessage }}</p>
                <RouterLink to="/apps" class="btn">Go to PixelCI</RouterLink>
            </template>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { dataFromAsync, OpenApiError } from '@zyno-io/openapi-client-codegen';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { LOCAL_STORAGE_AUTH_KEY } from '@/openapi-client';
import { ConnectedAppsApi, type IConnectedAppRequest } from '@/openapi-client-generated';
import ThemeMenu from '@/shared/components/theme-menu.vue';
import { useStore } from '@/store';

type Phase = 'framed' | 'loading' | 'ready' | 'returning' | 'not-found' | 'gone' | 'failed';

/** Long enough that a click aimed at something else (or a click-through from another window) can't land on Allow. */
const ARM_DELAY_MS = 600;

const store = useStore();
const route = useRoute();

const phase = ref<Phase>('loading');
const request = ref<IConnectedAppRequest>();
const busy = ref(false);
const armed = ref(false);
const errorMessage = ref<string>();
const selfUrl = location.href;

const requestId = computed(() => (typeof route.query.request === 'string' ? route.query.request : ''));

const endedTitle = computed(() => (phase.value === 'failed' ? "Couldn't load this request" : 'This request can no longer be used'));
const endedMessage = computed(() => {
    switch (phase.value) {
        case 'not-found':
            return "We couldn't find this request. Start again from the app you were connecting.";
        case 'gone':
            return 'It has expired or was already used. Start again from the app you were connecting.';
        default:
            return 'Something went wrong. Reload the page, or start again from the app you were connecting.';
    }
});

let armTimer: ReturnType<typeof setTimeout> | undefined;

// Allow only becomes clickable after the page has been visible, focused and loaded for ARM_DELAY_MS, and any loss of focus
// (another window or popup on top, tab switch) disarms it again. This defeats double-click/popup clickjacking, where the
// victim's second click lands on Allow right after an attacker window closes.
function disarm() {
    clearTimeout(armTimer);
    armTimer = undefined;
    armed.value = false;
}

function arm() {
    disarm();
    if (phase.value !== 'ready' || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    armTimer = setTimeout(() => {
        armTimer = undefined;
        armed.value = phase.value === 'ready' && document.visibilityState === 'visible' && document.hasFocus();
    }, ARM_DELAY_MS);
}

function onVisibilityChange() {
    if (document.visibilityState === 'visible') arm();
    else disarm();
}

watch(phase, async value => {
    if (value !== 'ready') return disarm();
    await nextTick();
    arm();
});

onMounted(() => {
    // Checked here, in the component: with storage partitioning plus a provider auto-redirect, a framed copy of the SPA can end
    // up signed in, so this must not rely on the page never being framed. It also holds when the frame is sandboxed.
    if (window.top !== window.self) {
        phase.value = 'framed';
        return;
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', disarm);
    window.addEventListener('focus', arm);
    void load();
});

onBeforeUnmount(() => {
    disarm();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', disarm);
    window.removeEventListener('focus', arm);
});

function statusOf(err: unknown): number | undefined {
    return err instanceof OpenApiError ? err.response?.status : undefined;
}

async function load() {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId.value)) {
        phase.value = 'not-found';
        return;
    }
    try {
        request.value = await dataFromAsync(ConnectedAppsApi.getConnectedAppsGetRequest({ query: { request: requestId.value } }));
        phase.value = 'ready';
    } catch (err) {
        const status = statusOf(err);
        // 401: the global handler has already dropped the session, which puts the sign-in screen over this route with the
        // request id preserved in returnTo; there is nothing to show here.
        if (status === 401) return;
        phase.value = status === 404 ? 'not-found' : status === 410 ? 'gone' : 'failed';
    }
}

async function decide(kind: 'approve' | 'deny') {
    if (busy.value || (kind === 'approve' && !armed.value)) return;
    busy.value = true;
    errorMessage.value = undefined;
    try {
        const call = kind === 'approve' ? ConnectedAppsApi.postConnectedAppsApprove : ConnectedAppsApi.postConnectedAppsDeny;
        const { redirectUrl } = await dataFromAsync(call({ body: { request: requestId.value } }));
        phase.value = 'returning';
        // The redirect carries the authorization code: it is never logged, stored or sent anywhere but the navigation.
        location.assign(redirectUrl);
    } catch (err) {
        busy.value = false;
        const status = statusOf(err);
        if (status === 401) return;
        if (status === 404) phase.value = 'not-found';
        else if (status === 410) phase.value = 'gone';
        else errorMessage.value = "That didn't go through. Try again.";
    }
}

function switchAccount() {
    localStorage.removeItem(LOCAL_STORAGE_AUTH_KEY);
    store.showProviderPicker = true;
    store.sessionUser = null;
}
</script>

<style lang="scss" scoped>
.consent-card {
    max-width: 460px;
    text-align: left;
}

.consent-card h1 {
    text-align: center;
    overflow-wrap: anywhere;
}

.client-name {
    font-weight: 700;
}

.consent-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px 0;
    color: var(--text-2);
    font-size: 13px;
}

.unverified {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
}

.hint {
    color: var(--text-3);
    font-size: 12px;
}

.return-to {
    align-items: center;
    font-size: 14px;

    strong {
        overflow-wrap: anywhere;
    }
}

.abilities {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 13px;
    color: var(--text-2);

    li {
        display: flex;
        gap: 10px;
        align-items: flex-start;
    }

    i {
        width: 14px;
        margin-top: 3px;
        font-size: 12px;
        text-align: center;
    }

    li:first-child i {
        color: var(--success);
    }

    li:last-child i {
        color: var(--text-3);
    }
}

.signed-in {
    color: var(--text-2);
    font-size: 13px;
}

.actions {
    display: flex;
    gap: 10px;

    .btn {
        flex: 1;
    }
}

.revoke-hint {
    text-align: center;
}
</style>
