import 'fake-indexeddb/auto'
import { beforeEach } from 'vitest'
import { FakeLockManager, setLocks } from './helpers/locks'

beforeEach(() => {
    setLocks(new FakeLockManager())
})
