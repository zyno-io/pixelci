import { onBeforeUnmount, type Ref, ref, watch } from 'vue';

/** An element's distance below the document top, kept current as anything above it resizes (a window virtualizer's scrollMargin). */
export function useDocumentTop(target: Ref<HTMLElement | undefined>) {
    const top = ref(0);
    const read = () => {
        const el = target.value;
        if (el?.isConnected) top.value = el.getBoundingClientRect().top + window.scrollY;
    };
    // The page root resizes whenever anything in it does: a header wrapping, a notice appearing.
    const observer = new ResizeObserver(read);
    watch(
        target,
        el => {
            observer.disconnect();
            if (!el) return;
            observer.observe(el);
            if (el.parentElement) observer.observe(el.parentElement);
            read();
        },
        { flush: 'post' }
    );
    window.addEventListener('resize', read);
    onBeforeUnmount(() => {
        observer.disconnect();
        window.removeEventListener('resize', read);
    });
    return top;
}
