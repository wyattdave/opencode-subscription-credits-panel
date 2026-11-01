import { getSnapshot } from '../providers.mjs'

const snapshot = await getSnapshot({ force: true })
console.log(JSON.stringify(snapshot, null, 2))
