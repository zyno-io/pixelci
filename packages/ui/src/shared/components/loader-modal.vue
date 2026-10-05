<template>
    <VfModal id="m-loader">
        <Loader />
    </VfModal>
</template>

<script lang="ts" setup>
import { VfModal } from '@zyno-io/vue-foundation';

import Loader from './loader.vue';
</script>

<style lang="scss">
#m-loader {
    .vf-modal {
        min-width: auto;
    }

    .vf-modal-content {
        padding: 8px;
    }
}
</style>
