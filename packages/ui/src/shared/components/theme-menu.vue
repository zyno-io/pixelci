<template>
    <DropdownMenu label="Theme" trigger-class="icon-trigger">
        <template #trigger>
            <i :class="currentIcon" aria-hidden="true" />
        </template>
        <div class="menu-label">Theme</div>
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            class="menu-item"
            role="menuitemradio"
            :aria-checked="mode === option.value"
            @click="setMode(option.value)"
        >
            <i :class="option.icon" aria-hidden="true" />
            {{ option.label }}
            <i v-if="mode === option.value" class="fa-solid fa-check check" aria-hidden="true" />
        </button>
    </DropdownMenu>
</template>

<script lang="ts" setup>
import { computed } from 'vue';

import { type ThemeMode, useTheme } from '@/composables/useTheme';

import DropdownMenu from './dropdown-menu.vue';

const { mode, isDark, setMode } = useTheme();

const options: { value: ThemeMode; label: string; icon: string }[] = [
    { value: 'system', label: 'System', icon: 'fa-solid fa-desktop' },
    { value: 'light', label: 'Light', icon: 'fa-regular fa-sun' },
    { value: 'dark', label: 'Dark', icon: 'fa-regular fa-moon' }
];

const currentIcon = computed(() => {
    if (mode.value === 'system') return 'fa-solid fa-circle-half-stroke';
    return isDark.value ? 'fa-regular fa-moon' : 'fa-regular fa-sun';
});
</script>
