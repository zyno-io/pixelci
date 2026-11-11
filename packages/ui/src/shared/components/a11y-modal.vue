<template>
    <VfModal ref="modal" @close="emit('close')">
        <slot />
    </VfModal>
</template>

<script lang="ts" setup>
/**
 * VfModal wrapper adding what the foundation lacks: dialog semantics, focus
 * management (move in, trap Tab, restore on close) and Escape-to-close.
 * Escape calls the same `close` handler as the Cancel button.
 */
import { VfModal } from '@zyno-io/vue-foundation';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const emit = defineEmits<{ close: [] }>();

const modal = ref<InstanceType<typeof VfModal>>();
const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;

let wrap: HTMLElement | null = null;
let dialog: HTMLElement | null = null;
let observer: MutationObserver | null = null;

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

function focusables(): HTMLElement[] {
    if (!dialog) return [];
    return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        el => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0
    );
}

function focusFirst() {
    const items = focusables();
    const field = items.find(el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !(el as HTMLInputElement).readOnly);
    (field ?? items[0] ?? dialog)?.focus();
}

function labelDialog() {
    if (!dialog) return;
    const heading = dialog.querySelector('h2');
    if (!heading) return;
    if (!heading.id) heading.id = `modal-title-${Math.random().toString(36).slice(2, 9)}`;
    dialog.setAttribute('aria-labelledby', heading.id);
}

function isTopmost() {
    const wraps = [...document.querySelectorAll<HTMLElement>('.vf-modal-wrap:not(.hidden)')];
    return wraps[wraps.length - 1] === wrap;
}

function onKeydown(e: KeyboardEvent) {
    // another handler (open menu, IME) already consumed the key
    if (e.defaultPrevented || e.isComposing) return;
    if (!isTopmost()) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        emit('close');
        return;
    }

    if (e.key === 'Tab') {
        const items = focusables();
        if (!items.length) {
            e.preventDefault();
            dialog?.focus();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!dialog?.contains(active)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && (active === first || active === dialog)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }
}

onMounted(() => {
    wrap = (modal.value?.$el as HTMLElement | undefined) ?? null;
    dialog = wrap?.querySelector<HTMLElement>('.vf-modal') ?? null;
    if (!dialog) return;

    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    labelDialog();
    focusFirst();

    // when the content swaps (e.g. form -> success view) the focused element
    // disappears; re-label and move focus back inside
    observer = new MutationObserver(() => {
        labelDialog();
        if (isTopmost() && !dialog!.contains(document.activeElement)) focusFirst();
    });
    observer.observe(dialog, { childList: true, subtree: true });

    window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    observer?.disconnect();
    // the trigger can be gone (e.g. the list reloaded after create); fall back to the page
    void nextTick(() => {
        if (trigger && document.contains(trigger)) trigger.focus();
        else document.getElementById('main')?.focus();
    });
});
</script>
