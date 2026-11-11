<template>
    <div class="segmented" role="group" :aria-label="label">
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            :aria-pressed="modelValue === option.value"
            :data-testid="option.testId"
            @click="emit('update:modelValue', option.value)"
        >
            <slot name="option" :option="option">{{ option.label }}</slot>
        </button>
    </div>
</template>

<script lang="ts" setup generic="T extends string">
/**
 * Joined toggle buttons for the review screen header (filter, zoom). Each option is a real button
 * with aria-pressed, grouped and named for assistive tech.
 */
defineProps<{
    label: string;
    modelValue: T;
    options: { value: T; label: string; testId?: string }[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: T] }>();
</script>

<style lang="scss" scoped>
.segmented {
    display: inline-flex;
    flex-shrink: 0;
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);

    button {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--border-strong);
        border-radius: 0;
        background: var(--surface);
        color: var(--text-2);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        transition:
            background-color 0.12s,
            color 0.12s;

        & + button {
            margin-left: -1px;
        }

        &:first-child {
            border-radius: var(--radius) 0 0 var(--radius);
        }

        &:last-child {
            border-radius: 0 var(--radius) var(--radius) 0;
        }

        &:hover {
            background: var(--surface-2);
            color: var(--text);
        }

        &[aria-pressed='true'] {
            background: var(--surface-3);
            color: var(--text);
        }

        // Lift the focused button so its ring isn't covered by the neighbour's overlapping border.
        &:focus-visible {
            z-index: 1;
        }
    }
}
</style>
