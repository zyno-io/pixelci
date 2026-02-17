<template>
    <div id="page-wrapper">
        <nav>
            <div class="nav-left">
                <a class="title" @click="goHome">PixelCI</a>
            </div>
            <div class="nav-right">
                <a
                    class="nav-icon"
                    @click="toggleTheme"
                    :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
                >
                    <i :class="isDark ? 'fa fa-sun' : 'fa fa-moon'" />
                </a>
                <div v-if="store.isAdmin" class="admin-dropdown">
                    <i class="fa fa-gear" />
                    <div class="dropdown-menu">
                        <RouterLink to="/admin/vcs-integrations" class="dropdown-item">VCS Integrations</RouterLink>
                        <RouterLink to="/admin/users" class="dropdown-item">Users</RouterLink>
                    </div>
                </div>
                <a class="logout" @click="logout">Logout</a>
            </div>
        </nav>

        <main>
            <slot />
        </main>
    </div>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue';

import { LOCAL_STORAGE_AUTH_KEY } from '@/openapi-client';
import router from '@/router';
import { useStore } from '@/store';

const store = useStore();

const THEME_OVERRIDE_KEY = 'pixelci:theme';
const isDark = ref(document.documentElement.classList.contains('dark'));

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function getSystemPreference(): 'light' | 'dark' {
    return mediaQuery.matches ? 'dark' : 'light';
}

function applyTheme(dark: boolean) {
    isDark.value = dark;
    document.documentElement.classList.toggle('dark', dark);
}

function toggleTheme() {
    const nextDark = !isDark.value;
    const nextTheme = nextDark ? 'dark' : 'light';

    if (nextTheme === getSystemPreference()) {
        localStorage.removeItem(THEME_OVERRIDE_KEY);
    } else {
        localStorage.setItem(THEME_OVERRIDE_KEY, nextTheme);
    }

    applyTheme(nextDark);
}

function onSystemThemeChange(e: MediaQueryListEvent) {
    if (!localStorage.getItem(THEME_OVERRIDE_KEY)) {
        applyTheme(e.matches);
    }
}

function goHome() {
    router.push('/');
}

function logout() {
    store.sessionUser = null;
    localStorage.removeItem(LOCAL_STORAGE_AUTH_KEY);
}

onMounted(() => {
    mediaQuery.addEventListener('change', onSystemThemeChange);
});

onUnmounted(() => {
    mediaQuery.removeEventListener('change', onSystemThemeChange);
});
</script>

<style lang="scss" scoped>
@reference "tailwindcss";

#page-wrapper {
    @apply flex-1 flex flex-col;
}

nav {
    @apply p-6 border-b border-neutral-500/25 flex justify-between items-center;

    .nav-left {
        @apply flex items-center gap-6;
    }

    .nav-right {
        @apply flex items-center gap-6;
    }

    .title {
        @apply text-xl font-semibold select-none cursor-pointer;
    }

    .nav-icon {
        @apply cursor-pointer text-neutral-400 hover:text-neutral-600 transition-colors;
    }

    .admin-dropdown {
        @apply relative cursor-pointer;

        > i {
            @apply text-neutral-400 hover:text-neutral-600 transition-colors;
        }

        .dropdown-menu {
            @apply absolute right-0 top-full mt-2 py-1 bg-neutral-800 border border-neutral-500/25 rounded-md shadow-lg min-w-[180px] opacity-0 invisible transition-all duration-100;
        }

        &:hover .dropdown-menu {
            @apply opacity-100 visible;
        }

        .dropdown-item {
            @apply block px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-500/15 hover:text-white transition-colors;
        }
    }

    .logout {
        @apply cursor-pointer;
    }
}
</style>

<style lang="scss">
@reference "tailwindcss";

html.dark nav .nav-icon,
html.dark nav .admin-dropdown > i {
    @apply text-neutral-400 hover:text-neutral-200;
}
</style>
