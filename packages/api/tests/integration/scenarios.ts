import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';

export interface IScenario {
    branch: string;
    screens: {
        name: string;
        file: string;
        expectedStatus: BuildScreenEntity['status'];
    }[];
    expectedStatus: BuildEntity['status'];
    shouldApprove: boolean;
    /** Tombstones (screens removed vs the reference build) expected on the build; checked when set. */
    expectedRemoved?: { name: string; status: BuildScreenEntity['status'] }[];
}

export const TestScenarios: IScenario[] = [
    // 1: initial
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-1',
                file: 'finder-1.png',
                expectedStatus: 'new'
            }
        ],
        expectedStatus: 'needs review',
        shouldApprove: true
    },

    // 2: create a branch and add a screen. don't approve.
    {
        branch: 'test-1',
        screens: [
            {
                name: 'finder-1',
                file: 'finder-1.png',
                expectedStatus: 'no changes'
            },
            {
                name: 'finder-2',
                file: 'finder-2.png',
                expectedStatus: 'new'
            }
        ],
        expectedStatus: 'needs review',
        shouldApprove: false
    },

    // 3: make a change to the new screen and approve
    {
        branch: 'test-1',
        screens: [
            {
                name: 'finder-1',
                file: 'finder-1.png',
                expectedStatus: 'no changes'
            },
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'new'
            }
        ],
        expectedStatus: 'needs review',
        shouldApprove: true
    },

    // 4: new build to the branch with no visual changes
    {
        branch: 'test-1',
        screens: [
            {
                name: 'finder-1',
                file: 'finder-1.png',
                expectedStatus: 'no changes'
            },
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'changes approved'
            }
        ],
        expectedStatus: 'changes approved',
        shouldApprove: false
    },

    // 5: new build to the branch changing back to the original screen
    {
        branch: 'test-1',
        screens: [
            {
                name: 'finder-1',
                file: 'finder-1.png',
                expectedStatus: 'no changes'
            },
            {
                name: 'finder-2',
                file: 'finder-2.png',
                expectedStatus: 'needs review'
            }
        ],
        expectedStatus: 'needs review',
        shouldApprove: true
    },

    // 6: merge changes back to the main branch
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-1',
                file: 'finder-1.png',
                expectedStatus: 'no changes'
            },
            {
                name: 'finder-2',
                file: 'finder-2.png',
                expectedStatus: 'changes approved'
            }
        ],
        expectedStatus: 'changes approved',
        shouldApprove: false
    },

    // 7: new branch, removes screen 1 (a removal needs review)
    {
        branch: 'test-2',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2.png',
                expectedStatus: 'no changes'
            }
        ],
        expectedStatus: 'needs review',
        expectedRemoved: [{ name: 'finder-1', status: 'needs review' }],
        shouldApprove: false
    },

    // 8: another build to the branch with no visual changes (the removal is still unapproved)
    {
        branch: 'test-2',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2.png',
                expectedStatus: 'no changes'
            }
        ],
        expectedStatus: 'needs review',
        expectedRemoved: [{ name: 'finder-1', status: 'needs review' }],
        shouldApprove: false
    },

    // 9: change screen 2 and approve (approving also accepts the removal of screen 1)
    {
        branch: 'test-2',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'needs review'
            }
        ],
        expectedStatus: 'needs review',
        shouldApprove: true
    },

    // 10: merge back to main
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'changes approved'
            }
        ],
        expectedStatus: 'changes approved',
        shouldApprove: false
    },

    // 11: new build on main with no visual changes
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'no changes'
            }
        ],
        expectedStatus: 'no changes',
        shouldApprove: false
    },

    // 12: new branch with no changes
    {
        branch: 'test-3',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'no changes'
            }
        ],
        expectedStatus: 'no changes',
        shouldApprove: false
    },

    // 13: another new branch changing the screen back
    {
        branch: 'test-4',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2.png',
                expectedStatus: 'needs review'
            }
        ],
        expectedStatus: 'needs review',
        shouldApprove: false
    },

    // 14: main adds a screen (never seen before) and approves it
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'no changes'
            },
            { name: 'finder-3', file: 'finder-1-changed.png', expectedStatus: 'new' }
        ],
        expectedStatus: 'needs review',
        expectedRemoved: [],
        shouldApprove: true
    },

    // 15: main drops that screen: needs review until approved; approving accepts the removal
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'no changes'
            }
        ],
        expectedStatus: 'needs review',
        expectedRemoved: [{ name: 'finder-3', status: 'needs review' }],
        shouldApprove: true
    },

    // 16: the next main build without it passes (the approved removal is not removed again)
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'no changes'
            }
        ],
        expectedStatus: 'no changes',
        expectedRemoved: [],
        shouldApprove: false
    },

    // 17: the screen reappears with a new image: it is new again
    {
        branch: 'main',
        screens: [
            {
                name: 'finder-2',
                file: 'finder-2-changed.png',
                expectedStatus: 'no changes'
            },
            {
                name: 'finder-3',
                file: 'finder-2-changed-2.png',
                expectedStatus: 'new'
            }
        ],
        expectedStatus: 'needs review',
        expectedRemoved: [],
        shouldApprove: false
    }
];
