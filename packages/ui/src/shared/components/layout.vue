<template>
    <div class="shell">
        <a class="skip-link" href="#main">Skip to content</a>
        <header class="topbar">
            <div class="topbar-inner">
                <RouterLink to="/" class="brand" aria-label="PixelCI home">
                    <span class="brand-mark" aria-hidden="true"><i class="fa-solid fa-border-all" /></span>
                    <span class="brand-name">PixelCI</span>
                </RouterLink>
                <nav class="nav" aria-label="Primary">
                    <RouterLink to="/apps" class="nav-link" active-class="active">Apps</RouterLink>
                </nav>
                <div class="topbar-right">
                    <ThemeMenu />
                    <DropdownMenu v-if="store.isAdmin" label="Administration" trigger-class="icon-trigger">
                        <template #trigger><i class="fa-solid fa-gear" aria-hidden="true" /></template>
                        <div class="menu-label">Administration</div>
                        <RouterLink to="/admin/vcs-integrations" class="menu-item" role="menuitem">
                            <i class="fa-solid fa-plug" aria-hidden="true" /> VCS Integrations
                        </RouterLink>
                        <RouterLink to="/admin/users" class="menu-item" role="menuitem">
                            <i class="fa-solid fa-users" aria-hidden="true" /> Users
                        </RouterLink>
                    </DropdownMenu>
                    <button type="button" class="btn ghost logout" @click="logout">
                        <i class="fa-solid fa-arrow-right-from-bracket" aria-hidden="true" /> Logout
                    </button>
                </div>
            </div>
        </header>
        <main id="main" tabindex="-1"><slot /></main>
    </div>
</template>

<script lang="ts" setup>
import { LOCAL_STORAGE_AUTH_KEY } from '@/openapi-client';
import { useStore } from '@/store';

import DropdownMenu from './dropdown-menu.vue';
import ThemeMenu from './theme-menu.vue';

const store = useStore();

function logout() {
    store.sessionUser = null;
    localStorage.removeItem(LOCAL_STORAGE_AUTH_KEY);
}
</script>

<style lang="scss" scoped>
.shell {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.skip-link {
    position: absolute;
    left: 12px;
    top: -40px;
    z-index: 100;
    padding: 8px 12px;
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--accent-text);

    &:focus {
        top: 10px;
    }
}

.topbar {
    position: sticky;
    top: 0;
    z-index: 40;
    height: var(--header-h);
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: saturate(1.4) blur(10px);
}

.topbar-inner {
    display: flex;
    align-items: center;
    gap: 18px;
    height: 100%;
    padding: 0 16px;
}

.brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    color: var(--text);
    font-weight: 650;
    font-size: 14px;
    letter-spacing: -0.01em;
    text-decoration: none !important;
}

.brand-mark {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: var(--text);
    color: var(--bg);
    font-size: 11px;
}

.nav {
    display: flex;
    gap: 2px;
}

.nav-link {
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
    text-decoration: none !important;

    &:hover {
        background: var(--surface-2);
        color: var(--text);
    }

    &.active {
        background: var(--surface-3);
        color: var(--text);
    }
}

.topbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;

    :deep(.icon-trigger) {
        justify-content: center;
        width: 32px;
        padding: 0;
    }
}

main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;

    &:focus {
        outline: none;
    }
}

@media (max-width: 640px) {
    .topbar-inner {
        gap: 10px;
        padding: 0 12px;
    }

    .brand-name {
        display: none;
    }

    .nav-link {
        padding: 6px 8px;
    }
}

@media (max-width: 360px) {
    .topbar-inner {
        gap: 8px;
        padding: 0 8px;
    }
}
</style>
