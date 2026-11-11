<template>
    <div class="tolerance-fields">
        <div v-for="field in TOLERANCE_FIELDS" :key="field.key" class="tolerance-row" :class="{ 'is-custom': modelValue[field.key] != null }">
            <div class="tolerance-text">
                <label :for="`${idPrefix}-${field.key}`">{{ field.label }}</label>
                <p :id="`${idPrefix}-${field.key}-hint`" class="tolerance-hint">{{ field.hint }}</p>
            </div>

            <div class="tolerance-control">
                <div class="tolerance-entry">
                    <div class="num-field" :class="{ invalid: errors[field.key], disabled }">
                        <input
                            :id="`${idPrefix}-${field.key}`"
                            v-model="text[field.key]"
                            type="number"
                            inputmode="decimal"
                            :min="field.min"
                            :max="field.max"
                            :step="field.step"
                            :placeholder="formatNumber(inherited[field.key])"
                            :disabled="disabled"
                            :aria-describedby="`${idPrefix}-${field.key}-hint ${idPrefix}-${field.key}-state`"
                            :aria-invalid="!!errors[field.key]"
                            :data-testid="`tolerance-${field.key}`"
                            @input="onInput(field, $event)"
                        />
                        <span v-if="field.suffix" class="suffix" aria-hidden="true">{{ field.suffix }}</span>
                    </div>
                </div>

                <p :id="`${idPrefix}-${field.key}-state`" class="tolerance-state" :class="{ error: errors[field.key] }">
                    <template v-if="errors[field.key]">{{ errors[field.key] }}</template>
                    <template v-else-if="modelValue[field.key] != null">
                        {{ capitalize(inheritedLabel) }}: {{ formatTolerance(field.key, inherited[field.key]) }}
                        <span class="sep" aria-hidden="true">·</span>
                        <button
                            type="button"
                            class="link-btn"
                            :disabled="disabled"
                            :aria-label="`Reset ${field.label} to the ${inheritedLabel}`"
                            :data-testid="`tolerance-reset-${field.key}`"
                            @click="reset(field)"
                        >
                            Reset
                        </button>
                    </template>
                    <template v-else>Using the {{ inheritedLabel }}</template>
                </p>
            </div>
        </div>
    </div>
</template>

<script lang="ts" setup>
/**
 * The three comparison tolerances as number fields. An empty field inherits: it shows the inherited
 * value as its placeholder and says where that value comes from. Typing overrides it; the reset
 * button returns it to inheriting. Emits only valid values; `validity` reports whether every field
 * currently holds something usable.
 */
import { reactive, watch } from 'vue';

import {
    formatNumber,
    formatTolerance,
    type IToleranceField,
    type IToleranceOverrides,
    type ITolerances,
    TOLERANCE_FIELDS,
    type ToleranceKey
} from '@/shared/tolerances';

const props = defineProps<{
    modelValue: IToleranceOverrides;
    inherited: ITolerances;
    /** Where an empty field's value comes from, e.g. "app default". */
    inheritedLabel: string;
    idPrefix: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: IToleranceOverrides];
    validity: [valid: boolean];
}>();

// number inputs report '' for both empty and unparseable text, and a number once valid
const text = reactive<Record<ToleranceKey, string | number>>({ colorTolerance: '', shiftTolerance: '', diffPctTolerance: '' });
const errors = reactive<Record<ToleranceKey, string>>({ colorTolerance: '', shiftTolerance: '', diffPctTolerance: '' });

function toText(value: number | null) {
    return value == null ? '' : formatNumber(value);
}

function parse(field: IToleranceField, input?: HTMLInputElement | null): { value: number | null; error: string } {
    const raw = String(text[field.key] ?? '').trim();
    // A number field reports '' for text it can't parse ("-", "1e"); that is not an empty field.
    if (input?.validity.badInput) return { value: null, error: `Enter ${field.min} to ${field.max}` };
    if (raw === '') return { value: null, error: '' };
    const value = Number(raw);
    const range = `${field.min} to ${field.max}`;
    if (!Number.isFinite(value) || value < field.min || value > field.max) return { value: null, error: `Enter ${range}` };
    if (field.integer && !Number.isInteger(value)) return { value: null, error: `Whole pixels, ${range}` };
    return { value, error: '' };
}

// Pull in outside changes (another screen, a save, a reset) without disturbing what's being typed:
// text is only rewritten when it no longer parses to the model's value.
watch(
    () => props.modelValue,
    model => {
        for (const field of TOLERANCE_FIELDS) {
            const { value, error } = parse(field);
            if (error || value !== model[field.key]) {
                text[field.key] = toText(model[field.key]);
                errors[field.key] = '';
            }
        }
        emit(
            'validity',
            TOLERANCE_FIELDS.every(f => !errors[f.key])
        );
    },
    { immediate: true }
);

function onInput(field: IToleranceField, e?: Event) {
    const { value, error } = parse(field, e?.target as HTMLInputElement | undefined);
    errors[field.key] = error;
    emit(
        'validity',
        TOLERANCE_FIELDS.every(f => !errors[f.key])
    );
    if (error || value === props.modelValue[field.key]) return;
    emit('update:modelValue', { ...props.modelValue, [field.key]: value });
}

function reset(field: IToleranceField) {
    text[field.key] = '';
    onInput(field);
}

function capitalize(value: string) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
</script>

<style lang="scss" scoped>
.tolerance-fields {
    display: flex;
    flex-direction: column;
    container-type: inline-size;
}
.tolerance-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 4px 16px;
    padding: 12px 0;

    & + & {
        border-top: 1px solid var(--border);
    }
    &:first-child {
        padding-top: 0;
    }
    &:last-child {
        padding-bottom: 0;
    }
}
.tolerance-text label {
    display: block;
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
}
.tolerance-hint {
    margin-top: 2px;
    color: var(--text-3);
    font-size: 12px;
    text-wrap: pretty;
}
.tolerance-control {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
}
.tolerance-entry {
    display: flex;
    align-items: center;
    gap: 4px;
}
// One bordered box holding the number and its unit; the box takes the field's focus treatment.
.num-field {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 104px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
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
    &.disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }

    input {
        flex: 1;
        min-width: 0;
        width: 100%;
        height: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        appearance: textfield;

        &::placeholder {
            color: var(--placeholder);
        }
        &:focus {
            outline: none;
        }
        &:disabled {
            cursor: not-allowed;
        }
        &::-webkit-outer-spin-button,
        &::-webkit-inner-spin-button {
            margin: 0;
            appearance: none;
        }
    }
    .suffix {
        flex-shrink: 0;
        color: var(--text-3);
        font-size: 12px;
    }
}
// In a narrow column (the lightbox panel) the hint would wrap to four or five lines beside the field,
// so the label keeps the field's line and the hint and state run full width beneath.
@container (max-width: 400px) {
    .tolerance-row {
        grid-template-areas:
            'label control'
            'hint hint'
            'state state';
        align-items: center;
        gap: 4px 12px;
    }
    .tolerance-text,
    .tolerance-control {
        display: contents;
    }
    .tolerance-text label {
        grid-area: label;
    }
    .tolerance-hint {
        grid-area: hint;
        margin-top: 2px;
    }
    .tolerance-entry {
        grid-area: control;
    }
    .tolerance-row .tolerance-state {
        grid-area: state;
        text-align: left;
        white-space: normal;
    }
}
// The value a row would fall back to reads as ink once it is overridden, so custom rows stand out.
.is-custom .num-field input {
    font-weight: 600;
}
.tolerance-state {
    color: var(--text-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;

    &.error {
        color: var(--danger);
    }
    .sep {
        margin: 0 4px;
    }
    .link-btn {
        font-size: inherit;

        &:disabled {
            opacity: 0.55;
            cursor: not-allowed;
        }
    }
}
</style>
