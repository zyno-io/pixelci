<template>
    <div id="admin-users">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div class="header">
                <h1>Users</h1>
            </div>

            <div class="list card admin-list">
                <div v-if="!users?.length" class="empty">
                    <i class="fa fa-users" />
                    <h2>No users</h2>
                </div>
                <div v-for="user in users" :key="user.id" class="item">
                    <div class="item-info">
                        <span class="name">{{ user.name }}</span>
                        <span v-if="user.id === currentUserId" class="badge you tag">You</span>
                        <span class="meta">{{ user.vcsName }}</span>
                    </div>
                    <div class="item-details">
                        <span class="meta">Last login: {{ $filters.dateTime(user.lastLoginAt, 'M/d/yy H:mm') }}</span>
                    </div>
                    <div class="item-actions">
                        <label class="toggle" :class="{ disabled: user.id === currentUserId }">
                            <input
                                type="checkbox"
                                :checked="user.isAdmin"
                                :disabled="user.id === currentUserId"
                                @change="toggleAdmin(user, $event)"
                            />
                            <span class="toggle-track">
                                <span class="toggle-dot" />
                            </span>
                            <span class="toggle-label">Admin</span>
                        </label>
                    </div>
                </div>
            </div>
        </template>
    </div>
</template>

<script lang="ts" setup>
import { dataFrom, dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert, showConfirm } from '@zyno-io/vue-foundation';
import { computed, onMounted, ref } from 'vue';

import { UsersApi, type IuserListResponse } from '@/openapi-client-generated';
import LoaderModal from '@/shared/components/loader-modal.vue';
import { useStore } from '@/store';

const store = useStore();
const users = ref<IuserListResponse[]>();
const isLoading = ref(true);

const currentUserId = computed(() => store.sessionUser?.id);

onMounted(load);

async function load() {
    try {
        const usersResponse = await UsersApi.getUsersIndex();
        users.value = dataFrom(usersResponse);
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isLoading.value = false;
    }
}

async function toggleAdmin(user: IuserListResponse, event: Event) {
    const checkbox = event.target as HTMLInputElement;
    const newValue = checkbox.checked;

    if (!newValue) {
        const ok = await showConfirm(`Revoke admin from "${user.name}"?`);
        if (!ok) {
            checkbox.checked = true;
            return;
        }
    }

    try {
        const result = await dataFromAsync(
            UsersApi.putUsersUpdate({
                path: { id: user.id },
                body: { isAdmin: newValue }
            })
        );
        user.isAdmin = result.isAdmin;
    } catch (err) {
        checkbox.checked = !newValue;
        handleErrorAndAlert(err);
    }
}
</script>

<style lang="scss" scoped>
.toggle {
    position: relative;
}
.toggle.disabled {
    opacity: 0.55;
    cursor: not-allowed;
}
.toggle input {
    position: absolute;
    width: 36px;
    height: 20px;
    opacity: 0;
}
.toggle-track {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 20px;
    background: var(--border-strong);
    transition: background-color 0.15s;
}
input:checked + .toggle-track {
    background: var(--accent);
}
input:focus-visible + .toggle-track {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
}
.toggle-dot {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--surface);
    transition: transform 0.15s;
}
input:checked + .toggle-track .toggle-dot {
    transform: translateX(16px);
}
.toggle-label {
    color: var(--text-2);
    font-size: 12px;
}
</style>
