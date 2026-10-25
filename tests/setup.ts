import 'fake-indexeddb/auto'
import { beforeEach } from 'vitest'
import { FakeLockManager, setLocks } from './helpers/locks'
import { setAcceptSyntheticEvents } from '@/utils/user-event'

beforeEach(() => {
    setLocks(new FakeLockManager())
    // テストで作ったクリックなども、ユーザーの操作として扱う（扱わないことを確かめるテストでは false にする）
    setAcceptSyntheticEvents(true)
})
