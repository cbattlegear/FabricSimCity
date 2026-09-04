import {
  AudienceType,
  UserDataFunctions,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions'

import { collectFabricTopology, type FabricTopologySnapshot } from './fabricTopology.js'

const udf = new UserDataFunctions()

udf.func(
  'readFabricTopology',
  async (ctx: RayfinContext): Promise<FabricTopologySnapshot> => {
    const token = ctx.getToken(AudienceType.Fabric)
    return collectFabricTopology({ token })
  },
  [udf.connection({ audienceType: AudienceType.Fabric })],
)
