import * as Sentry from '@sentry/vue';
import { defineStore } from 'pinia';

import type { ISessionResponse } from './openapi-client-generated';

type SessionUser = ISessionResponse;

export const useStore = defineStore('root', {
    state: () => ({
        sessionUser: null as SessionUser | null,
        globalError: null as string | null,
        selectedBranchId: null as string | null,
        // set when the user asked to switch account, so login shows the picker instead of auto-redirecting
        showProviderPicker: false
    }),

    getters: {
        isAdmin: state => state.sessionUser?.isAdmin ?? false
    }
});

export function setupStore() {
    let lastUserObj: SessionUser | null = null;
    useStore().$subscribe((_mutation, state) => {
        if (lastUserObj !== state.sessionUser) {
            lastUserObj = state.sessionUser;
            updateSentryScope(state.sessionUser);
        }
    });
}

function updateSentryScope(user: SessionUser | null) {
    const resolvedUser = user
        ? {
              id: String(user.id)
              // email: user.email ?? ''
          }
        : null;
    Sentry.setUser(resolvedUser);
}
