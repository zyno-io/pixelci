<template>
    <A11yModal @close="callback(false)">
        <div class="submit-confirm">
            <h2>{{ title }}</h2>
            <p>{{ message }}</p>

            <div class="form-actions">
                <button type="button" class="btn" data-testid="submit-cancel" @click="callback(false)">Cancel</button>
                <button type="button" class="btn primary" data-testid="submit-confirm" @click="callback(true)">
                    {{ confirmLabel }}
                </button>
            </div>
        </div>
    </A11yModal>
</template>

<script lang="ts" setup>
/**
 * Build-level submit confirmation for the review screen. The foundation's showConfirm() only offers
 * "Confirm"/"Cancel", so this names the action on the button. Presented with presentOverlay().
 * Focus starts on Cancel (A11yModal focuses the first control): submitting re-runs CI and
 * auto-approves unreviewed screens, so it should take a deliberate choice. Escape cancels.
 */
import A11yModal from '@/shared/components/a11y-modal.vue';

defineProps<{
    title: string;
    message: string;
    confirmLabel: string;
    callback: (ok: boolean) => void;
}>();
</script>

<style lang="scss" scoped>
.submit-confirm {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 440px;
    max-width: calc(100vw - 32px);
    padding: 24px;

    h2 {
        color: var(--text);
        font-size: 17px;
        font-weight: 600;
    }

    p {
        color: var(--text-2);
    }
}

@media (max-width: 640px) {
    .submit-confirm {
        padding: 18px;
    }
}
</style>
