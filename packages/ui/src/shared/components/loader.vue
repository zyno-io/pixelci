<template>
    <div class="loader" :class="{ center: position !== 'left' }" role="status" aria-label="Loading">
        <div
            class="inner"
            :class="{
                'text-6xl': size === '2xl',
                'text-5xl': size === 'xl',
                'text-4xl': !size || size === 'lg',
                'text-2xl': size === 'md',
                'text-xl': size === 'sm'
            }"
        >
            <i class="fa-solid fa-circle-notch fa-spin text-inherit" aria-hidden="true" />
        </div>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    position?: 'left' | 'center';
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
}>();
</script>

<style lang="scss" scoped>
@reference "tailwindcss";

i {
    font-size: inherit;
}

.loader {
    @apply p-4 flex;
    color: var(--accent);

    &.center {
        @apply justify-center;
    }
}

.inner {
    &.text-6xl {
        @apply text-[3.75rem];
    }

    &.text-5xl {
        @apply text-[3rem];
    }

    &.text-4xl {
        @apply text-[2.25rem];
    }

    &.text-2xl {
        @apply text-[1.5rem];
    }

    &.text-xl {
        @apply text-[1.25rem];
    }
}
</style>
