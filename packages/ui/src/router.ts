import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import Apps from '@/screens/apps.vue';

import AdminUsers from './screens/admin/users.vue';
import AdminVcsIntegrations from './screens/admin/vcs-integrations.vue';
import Builds from './screens/builds.vue';
import ConnectedApps from './screens/connected-apps.vue';
import Gallery from './screens/gallery.vue';
import Login from './screens/login.vue';
import NotFound from './screens/not-found.vue';
import OauthConsent from './screens/oauth-consent.vue';
import OauthError from './screens/oauth-error.vue';
import Screens from './screens/screens.vue';

declare module 'vue-router' {
    interface RouteMeta {
        /** Rendered full-page, after sign-in, without the app shell (e.g. OAuth consent). */
        bare?: boolean;
        /** Rendered without requiring sign-in. */
        public?: boolean;
    }
}

const routes: RouteRecordRaw[] = [
    {
        path: '/',
        redirect: '/apps'
    },
    {
        path: '/login',
        component: Login
    },
    {
        path: '/apps',
        name: 'apps',
        component: Apps
    },
    {
        path: '/apps/:id',
        name: 'builds',
        component: Builds
    },
    {
        path: '/apps/:id/screens',
        name: 'app-gallery',
        component: Gallery
    },
    {
        path: '/apps/:id/builds/:buildId',
        name: 'screens',
        component: Screens
    },
    {
        path: '/apps/:id/builds/:buildId/screens',
        name: 'build-gallery',
        component: Gallery
    },
    {
        path: '/connected-apps',
        name: 'connected-apps',
        component: ConnectedApps
    },
    {
        // The MCP authorization server sends users here (see OAuth.controller.ts); it carries `?request=<id>`.
        path: '/oauth/consent',
        name: 'oauth-consent',
        component: OauthConsent,
        meta: { bare: true }
    },
    {
        // Authorization requests that can't be trusted enough to redirect back to the client land here with `?reason=`. (Not
        // `?error=`: the login screen takes over that parameter on any route.)
        path: '/oauth/error',
        name: 'oauth-error',
        component: OauthError,
        meta: { public: true }
    },
    {
        path: '/admin/vcs-integrations',
        name: 'admin-vcs-integrations',
        component: AdminVcsIntegrations
    },
    {
        path: '/admin/users',
        name: 'admin-users',
        component: AdminUsers
    },
    {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: NotFound
    }
];

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes
});

const TITLES: Record<string, string> = {
    apps: 'Apps',
    builds: 'Builds',
    'connected-apps': 'Connected apps',
    'oauth-consent': 'Authorize access',
    'oauth-error': 'Authorization problem',
    'admin-users': 'Users',
    'admin-vcs-integrations': 'VCS Integrations',
    'not-found': 'Not found'
};

router.afterEach(to => {
    const title = typeof to.name === 'string' ? TITLES[to.name] : undefined;
    document.title = title ? `${title} · PixelCI` : 'PixelCI';
});

export default router;
