import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppConfig } from '../../src/config';
import { AppEntity, IApprovalMinRole } from '../../src/entities/App.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { AppAccessService } from '../../src/services/AppAccess.service';
import { IVcsProjectRole, VcsService } from '../../src/services/Vcs.service';
import { githubRoleFromPermissions } from '../../src/services/VcsGitHub.service';
import { gitlabRoleFromAccessLevel } from '../../src/services/VcsGitLab.service';

const VCS_ID = '00000000-0000-0000-0000-0000000000aa';

function makeUser(overrides: Partial<UserEntity> = {}): UserEntity {
    return { id: 'user-1', vcsId: VCS_ID, vcsUserId: '42', isAdmin: false, ...overrides } as UserEntity;
}

function makeApp(approvalMinRole: IApprovalMinRole = 'write', overrides: Partial<AppEntity> = {}): AppEntity {
    return { id: 'app-1', vcsId: VCS_ID, vcsProjectId: 7, projectPath: 'g/p', approvalMinRole, ...overrides } as AppEntity;
}

/** A fake VcsService: read access is `canRead`; the role comes from `role` (a value, or a function that may throw). */
function makeService(opts: { enforce?: boolean; canRead?: boolean; role?: IVcsProjectRole | (() => IVcsProjectRole) }) {
    const calls = { access: 0, role: 0 };
    const vcs = {
        async userCanAccessProject() {
            calls.access++;
            return opts.canRead ?? true;
        },
        async getUserProjectRole() {
            calls.role++;
            const role = opts.role ?? 'read';
            return typeof role === 'function' ? role() : role;
        }
    } as unknown as VcsService;
    const config = { ENFORCE_VCS_PROJECT_ACCESS: opts.enforce ?? true } as AppConfig;
    return { svc: new AppAccessService(vcs, config), calls };
}

describe('AppAccessService.canReview', () => {
    it('allows an admin without asking the VCS for a role', async () => {
        const { svc, calls } = makeService({ role: 'none' });
        assert.equal(await svc.canReview(makeUser({ isAdmin: true }), makeApp('maintain')), true);
        assert.equal(calls.role, 0);
    });

    it('still applies the read gate to admins', async () => {
        const { svc } = makeService({ canRead: false });
        assert.equal(await svc.canReview(makeUser({ isAdmin: true }), makeApp()), false);
    });

    it('denies non-admins when VCS enforcement is off, even for a read threshold', async () => {
        const { svc, calls } = makeService({ enforce: false, role: 'maintain' });
        assert.equal(await svc.canReview(makeUser(), makeApp('read')), false);
        assert.equal(await svc.canReview(makeUser({ isAdmin: true }), makeApp('read')), true);
        assert.equal(calls.role, 0);
    });

    it('read threshold: read access is enough, with no role lookup', async () => {
        const { svc, calls } = makeService({ role: 'none' });
        assert.equal(await svc.canReview(makeUser(), makeApp('read')), true);
        assert.equal(calls.role, 0);
    });

    it('read threshold: no read access denies', async () => {
        const { svc } = makeService({ canRead: false });
        assert.equal(await svc.canReview(makeUser(), makeApp('read')), false);
    });

    it('write threshold: read is denied, write and maintain are allowed', async () => {
        for (const [role, expected] of [
            ['none', false],
            ['read', false],
            ['write', true],
            ['maintain', true]
        ] as const) {
            const { svc } = makeService({ role });
            assert.equal(await svc.canReview(makeUser(), makeApp('write')), expected, `role ${role}`);
        }
    });

    it('maintain threshold: write is denied, maintain is allowed', async () => {
        for (const [role, expected] of [
            ['read', false],
            ['write', false],
            ['maintain', true]
        ] as const) {
            const { svc } = makeService({ role });
            assert.equal(await svc.canReview(makeUser(), makeApp('maintain')), expected, `role ${role}`);
        }
    });

    it('an unknown threshold fails closed', async () => {
        const { svc } = makeService({ role: 'maintain' });
        assert.equal(await svc.canReview(makeUser(), makeApp('owner' as IApprovalMinRole)), false);
    });

    it('a provider error denies and is not cached', async () => {
        let fail = true;
        const { svc, calls } = makeService({
            role: () => {
                if (fail) throw new Error('GitLab 502');
                return 'write';
            }
        });
        assert.equal(await svc.canReview(makeUser(), makeApp()), false);
        fail = false;
        assert.equal(await svc.canReview(makeUser(), makeApp()), true);
        assert.equal(calls.role, 2);
    });

    it('caches the role per user and project, and the threshold is applied to the cached role', async () => {
        const { svc, calls } = makeService({ role: 'write' });
        assert.equal(await svc.canReview(makeUser(), makeApp('write')), true);
        assert.equal(await svc.canReview(makeUser(), makeApp('write')), true);
        // Raising the app's threshold takes effect at once: the role is cached, not the decision.
        assert.equal(await svc.canReview(makeUser(), makeApp('maintain')), false);
        assert.equal(calls.role, 1);

        await svc.canReview(makeUser({ id: 'user-2' }), makeApp('write'));
        await svc.canReview(makeUser(), makeApp('write', { vcsProjectId: 8 }));
        assert.equal(calls.role, 3);
    });

    it('keeps the role cache apart from the read-access cache', async () => {
        const { svc, calls } = makeService({ role: 'write' });
        // Warm the read cache through canAccess, then ask for a role: the role lookup must still happen.
        assert.equal(await svc.canAccess({ kind: 'user', user: makeUser() }, makeApp()), true);
        assert.equal(await svc.canReview(makeUser(), makeApp()), true);
        assert.equal(calls.access, 1);
        assert.equal(calls.role, 1);
    });
});

describe('provider role mapping', () => {
    it('GitHub: admin/maintain → maintain, push → write, anything else → read', () => {
        assert.equal(githubRoleFromPermissions({ admin: true, maintain: false, push: true, triage: true, pull: true }), 'maintain');
        assert.equal(githubRoleFromPermissions({ admin: false, maintain: true, push: true }), 'maintain');
        assert.equal(githubRoleFromPermissions({ admin: false, maintain: false, push: true }), 'write');
        assert.equal(githubRoleFromPermissions({ admin: false, maintain: false, push: false, triage: true, pull: true }), 'read');
        assert.equal(githubRoleFromPermissions({ push: 'true' }), 'read');
        assert.equal(githubRoleFromPermissions(undefined), 'read');
        assert.equal(githubRoleFromPermissions(null), 'read');
    });

    it('GitLab: ≥40 → maintain, ≥30 → write, below → read', () => {
        assert.equal(gitlabRoleFromAccessLevel(50), 'maintain');
        assert.equal(gitlabRoleFromAccessLevel(40), 'maintain');
        assert.equal(gitlabRoleFromAccessLevel(30), 'write');
        assert.equal(gitlabRoleFromAccessLevel(20), 'read');
        assert.equal(gitlabRoleFromAccessLevel(0), 'read');
    });
});
