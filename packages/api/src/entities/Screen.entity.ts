import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, HasDefault, UuidString } from '@zyno-io/ts-server-foundation';

import { IMaskRect } from '../services/Mask';

@entity.name('screens')
@entity.index(['appId', 'name'], { unique: true })
export class ScreenEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    appId!: UuidString;
    name!: string;
    colorTolerance!: (number & DatabaseField<{ type: 'double precision' }>) | null;
    shiftTolerance!: (number & DatabaseField<{ type: 'integer' }>) | null;
    diffPctTolerance!: (number & DatabaseField<{ type: 'double precision' }>) | null;
    masks!: IMaskRect[] | null;
    masksVersion: (number & DatabaseField<{ type: 'integer' }>) & HasDefault = 0;
    masksUpdatedAt!: Date | null;
    masksUpdatedById!: UuidString | null;
    inheritAppMasks: boolean & HasDefault = true;
}
