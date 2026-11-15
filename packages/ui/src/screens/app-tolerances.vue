<template>
    <A11yModal @close="emit('close')">
        <div class="form-modal app-tolerances" data-testid="app-tolerances-dialog">
            <h2>Tolerances for {{ app.name }}</h2>
            <p class="lead">
                How strictly every screen in this app is compared with its reference. A screen can override any of these from its own view.
            </p>

            <ToleranceFields
                v-model="draft"
                :inherited="app.instanceTolerances"
                inherited-label="instance default"
                id-prefix="app-tolerance"
                :disabled="!store.isAdmin || isSaving"
                @validity="isValid = $event"
            />

            <p class="note">
                <template v-if="store.isAdmin">Saved values apply from the next build. Results of earlier builds stay as they are.</template>
                <template v-else>Only administrators can change an app's tolerances.</template>
            </p>

            <div class="form-actions">
                <button type="button" class="btn" data-testid="app-tolerances-cancel" @click="emit('close')">
                    {{ store.isAdmin ? 'Cancel' : 'Close' }}
                </button>
                <button
                    v-if="store.isAdmin"
                    type="button"
                    class="btn primary"
                    :disabled="!isDirty || !isValid || isSaving"
                    data-testid="app-tolerances-save"
                    @click="save"
                >
                    Save tolerances
                </button>
            </div>
        </div>
    </A11yModal>
</template>

<script lang="ts" setup>
/** App-wide comparison tolerances: editable by administrators, readable by everyone with access. */
import { handleErrorAndAlert, showToast } from '@zyno-io/vue-foundation';
import { computed, ref } from 'vue';

import { AppsApi, type IAppShowResponse } from '@/openapi-client-generated';
import A11yModal from '@/shared/components/a11y-modal.vue';
import ToleranceFields from '@/shared/components/tolerance-fields.vue';
import { type IToleranceOverrides, pickOverrides, sameOverrides } from '@/shared/tolerances';
import { useStore } from '@/store';

const props = defineProps<{
    app: IAppShowResponse;
    // A prop, not an emit: Vue drops events from a component unmounted while its save is in flight.
    onSaved?: (tolerances: IToleranceOverrides) => void;
}>();
const emit = defineEmits<{ close: [] }>();

const store = useStore();

const draft = ref<IToleranceOverrides>(pickOverrides(props.app));
const isValid = ref(true);
const isSaving = ref(false);
const isDirty = computed(() => !sameOverrides(draft.value, pickOverrides(props.app)));

async function save() {
    try {
        isSaving.value = true;
        const values = draft.value;
        await AppsApi.putAppsUpdate({ path: { id: props.app.id }, body: values });
        showToast({ message: `Tolerances saved for ${props.app.name}.` });
        props.onSaved?.(values);
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isSaving.value = false;
    }
}
</script>

<style lang="scss" scoped>
.app-tolerances {
    .lead {
        margin-top: -8px;
        color: var(--text-2);
        font-size: 13px;
        text-wrap: pretty;
    }
    .note {
        color: var(--text-3);
        font-size: 12px;
    }
    // .form-modal stacks every label above its control; these rows lay themselves out
    :deep(label) {
        display: block;
    }
}
</style>
