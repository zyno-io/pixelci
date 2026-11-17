<template>
    <ul class="mask-fields" data-testid="mask-fields">
        <li
            v-for="(mask, index) in modelValue"
            :key="mask.id"
            class="mask-row"
            :class="{ selected: mask.id === selectedId, invalid: rowError(mask) }"
            :data-testid="`mask-row`"
            @focusin="emit('select', mask.id)"
        >
            <div class="mask-row-head">
                <span class="mask-row-number" aria-hidden="true">{{ index + 1 }}</span>
                <input
                    :id="`${idPrefix}-${mask.id}-label`"
                    class="input mask-label"
                    type="text"
                    :value="mask.label ?? ''"
                    :maxlength="MAX_MASK_LABEL_LENGTH"
                    placeholder="Label (optional)"
                    :aria-label="`Mask ${index + 1} label`"
                    :disabled="disabled"
                    data-testid="mask-label"
                    @input="setLabel(mask, ($event.target as HTMLInputElement).value)"
                />
                <button
                    type="button"
                    class="btn ghost icon sm"
                    :aria-label="`Delete mask ${index + 1}`"
                    v-tooltip="'Delete mask'"
                    :disabled="disabled"
                    data-testid="mask-delete"
                    @click="emit('remove', mask.id)"
                >
                    <i class="fa fa-trash-can" aria-hidden="true" />
                </button>
            </div>

            <div class="mask-nums">
                <label v-for="field in MASK_FIELDS" :key="field.key" class="mask-num" :class="{ invalid: fieldErrors[`${mask.id}:${field.key}`] }">
                    <span class="mask-num-label" aria-hidden="true">{{ field.label }}</span>
                    <input
                        type="number"
                        inputmode="numeric"
                        step="1"
                        :min="field.min"
                        :value="shown(mask, field.key)"
                        :aria-label="`Mask ${index + 1} ${FIELD_NAMES[field.key]}`"
                        :aria-invalid="!!fieldErrors[`${mask.id}:${field.key}`]"
                        :disabled="disabled"
                        :data-testid="`mask-${field.key}`"
                        @input="onNumber(mask, field, $event)"
                        @blur="settle(mask, field)"
                    />
                </label>
            </div>

            <p v-if="rowError(mask)" class="mask-error" role="alert">{{ rowError(mask) }}</p>
        </li>
    </ul>
</template>

<script lang="ts" setup>
/**
 * One row per mask with X, Y, W and H fields and a label: the way to place a mask precisely, and the
 * path for anyone not using a pointer. Only valid values are emitted; `validity` reports whether every
 * field currently holds one.
 */
import { computed, reactive, watch } from 'vue';

import { type IMaskRect, MASK_FIELDS, MAX_MASK_LABEL_LENGTH, type MaskField, maskError } from '@/shared/masks';

const props = defineProps<{
    modelValue: IMaskRect[];
    selectedId?: string | null;
    idPrefix: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    'update:modelValue': [masks: IMaskRect[]];
    select: [id: string];
    remove: [id: string];
    validity: [valid: boolean];
}>();

const FIELD_NAMES: Record<MaskField, string> = { x: 'x', y: 'y', width: 'width', height: 'height' };

// What is typed while it doesn't parse, so a half-typed value isn't overwritten by the model.
const raw = reactive<Record<string, string>>({});
const fieldErrors = reactive<Record<string, string>>({});

const anyInvalid = computed(() => Object.values(fieldErrors).some(Boolean) || props.modelValue.some(m => !!maskError(m)));
watch(anyInvalid, valid => emit('validity', !valid), { immediate: true });

function shown(mask: IMaskRect, key: MaskField) {
    return raw[`${mask.id}:${key}`] ?? mask[key];
}

function rowError(mask: IMaskRect): string {
    for (const field of MASK_FIELDS) {
        const error = fieldErrors[`${mask.id}:${field.key}`];
        if (error) return error;
    }
    return maskError(mask);
}

function update(mask: IMaskRect, patch: Partial<IMaskRect>) {
    emit(
        'update:modelValue',
        props.modelValue.map(m => (m.id === mask.id ? { ...m, ...patch } : m))
    );
}

function onNumber(mask: IMaskRect, field: (typeof MASK_FIELDS)[number], e: Event) {
    const input = e.target as HTMLInputElement;
    const key = `${mask.id}:${field.key}`;
    const text = input.value.trim();
    const value = Number(text);
    if (input.validity.badInput || text === '' || !Number.isInteger(value) || value < field.min) {
        raw[key] = input.value;
        fieldErrors[key] =
            text !== '' && Number.isFinite(value) && !Number.isInteger(value) ? 'Use whole pixels' : `${field.label} is at least ${field.min}`;
        return;
    }
    delete raw[key];
    delete fieldErrors[key];
    if (value !== mask[field.key]) update(mask, { [field.key]: value });
}

function settle(mask: IMaskRect, field: (typeof MASK_FIELDS)[number]) {
    const key = `${mask.id}:${field.key}`;
    delete raw[key];
    delete fieldErrors[key];
}

function setLabel(mask: IMaskRect, value: string) {
    update(mask, { label: value.trim() === '' ? null : value });
}

// A deleted mask can't leave stale text behind.
watch(
    () => props.modelValue.map(m => m.id),
    ids => {
        for (const key of Object.keys(fieldErrors)) if (!ids.includes(key.split(':')[0])) delete fieldErrors[key];
        for (const key of Object.keys(raw)) if (!ids.includes(key.split(':')[0])) delete raw[key];
    }
);
</script>

<style lang="scss" scoped>
.mask-fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
}
.mask-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);

    &.selected {
        border-color: var(--focus);
        box-shadow: 0 0 0 3px var(--accent-soft);
    }
    &.invalid {
        border-color: var(--danger);
    }
}
.mask-row-head {
    display: flex;
    align-items: center;
    gap: 6px;
}
.mask-row-number {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    background: var(--neutral-soft);
    color: var(--neutral);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}
.mask-label {
    flex: 1;
    min-width: 0;
    height: 28px;
    font-size: 12px;
}
.mask-nums {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
}
.mask-num {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: 28px;
    padding: 0 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    transition:
        border-color 0.12s,
        box-shadow 0.12s;

    &:focus-within {
        border-color: var(--focus);
        box-shadow: 0 0 0 3px var(--accent-soft);
    }
    &.invalid {
        border-color: var(--danger);
    }

    input {
        flex: 1;
        min-width: 0;
        width: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        appearance: textfield;

        &:focus {
            outline: none;
        }
        &::-webkit-outer-spin-button,
        &::-webkit-inner-spin-button {
            margin: 0;
            appearance: none;
        }
    }
}
.mask-num-label {
    flex-shrink: 0;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
}
.mask-error {
    color: var(--danger);
    font-size: 12px;
}
</style>
