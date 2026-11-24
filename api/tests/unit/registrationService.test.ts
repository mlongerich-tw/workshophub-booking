import {
  cancelRegistration,
  registerForSession,
  validateRegistrationInput,
  type CancelRegistrationOptions,
  type CancelResult,
  type WaitlistPromotionContext,
  type WaitlistPromotionHook,
} from '../../src/services/registrationService'
import prisma from '../../src/lib/prisma'

jest.mock('../../src/lib/prisma', () => {
  const client = {
    trainingSession: {
      updateMany: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      fields: { capacity: 'capacity-field-ref' },
    },
    registration: {
      create: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  }
  client.$transaction.mockImplementation((fn: (tx: typeof client) => Promise<unknown>) =>
    fn(client)
  )
  return { __esModule: true, default: client }
})

const mockUpdateMany = prisma.trainingSession.updateMany as jest.Mock
const mockFindUnique = prisma.trainingSession.findUnique as jest.Mock
const mockUpdate = prisma.trainingSession.update as jest.Mock
const mockCreate = prisma.registration.create as jest.Mock
const mockCount = prisma.registration.count as jest.Mock
const mockRegFindFirst = prisma.registration.findFirst as jest.Mock
const mockRegUpdate = prisma.registration.update as jest.Mock
const mockTransaction = prisma.$transaction as jest.Mock

const input = { name: 'Ada Lovelace', email: 'ada@example.com' }

const createdRegistration = {
  id: 42,
  sessionId: 1,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  status: 'confirmed',
  createdAt: new Date('2026-11-23T05:00:00Z'),
}

const waitlistedRegistration = {
  id: 43,
  sessionId: 1,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  status: 'waitlisted',
  createdAt: new Date('2026-11-23T05:01:00Z'),
}

const availabilitySelect = { id: true, capacity: true, registered: true, waitlisted: true }

afterEach(() => {
  mockUpdateMany.mockReset()
  mockFindUnique.mockReset()
  mockCreate.mockReset()
  mockUpdate.mockReset()
  mockCount.mockReset()
  mockRegFindFirst.mockReset()
  mockRegUpdate.mockReset()
})

describe('validateRegistrationInput', () => {
  it('accepts name and email and trims them', () => {
    const result = validateRegistrationInput({ name: ' Ada ', email: ' ada@example.com ' })

    expect(result).toEqual({ ok: true, value: { name: 'Ada', email: 'ada@example.com' } })
  })

  it('ignores extra fields', () => {
    const result = validateRegistrationInput({ name: 'Ada', email: 'a@b.c', role: 'admin' })

    expect(result).toEqual({ ok: true, value: { name: 'Ada', email: 'a@b.c' } })
  })

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'Ada'],
    ['an array', []],
    ['a missing name', { email: 'a@b.c' }],
    ['a missing email', { name: 'Ada' }],
    ['a blank name', { name: '   ', email: 'a@b.c' }],
    ['a blank email', { name: 'Ada', email: '  ' }],
    ['a numeric name', { name: 123, email: 'a@b.c' }],
    ['an object email', { name: 'Ada', email: {} }],
  ])('rejects %s', (_label, body) => {
    const result = validateRegistrationInput(body)

    expect(result).toEqual({ ok: false, error: 'name and email are required' })
  })
})

describe('registerForSession', () => {
  it('claims a seat, creates the registration and returns updated availability', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockCreate.mockResolvedValue(createdRegistration)
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 20, registered: 6, waitlisted: 0 })

    const result = await registerForSession(1, input)

    expect(result).toEqual({
      kind: 'confirmed',
      registration: createdRegistration,
      session: { id: 1, capacity: 20, registered: 6, waitlisted: 0 },
    })
    expect(mockTransaction).toHaveBeenCalled()
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 1, registered: { lt: 'capacity-field-ref' } },
      data: { registered: { increment: 1 } },
    })
    expect(mockCreate).toHaveBeenCalledWith({
      data: { sessionId: 1, name: 'Ada Lovelace', email: 'ada@example.com', status: 'confirmed' },
    })
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 1 }, select: availabilitySelect })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('adds the registration to the waitlist when no seat could be claimed', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue({ id: 1 })
    mockUpdate.mockResolvedValue({ id: 1, capacity: 2, registered: 2, waitlisted: 3 })
    mockCreate.mockResolvedValue(waitlistedRegistration)
    mockCount.mockResolvedValue(3)

    const result = await registerForSession(1, input)

    expect(result).toEqual({
      kind: 'waitlisted',
      registration: waitlistedRegistration,
      position: 3,
      session: { id: 1, capacity: 2, registered: 2, waitlisted: 3 },
    })
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { waitlisted: { increment: 1 } },
      select: availabilitySelect,
    })
    expect(mockCreate).toHaveBeenCalledWith({
      data: { sessionId: 1, name: 'Ada Lovelace', email: 'ada@example.com', status: 'waitlisted' },
    })
    expect(mockCount).toHaveBeenCalledWith({
      where: { sessionId: 1, status: 'waitlisted', id: { lte: 43 } },
    })
  })

  it('returns not_found when no seat could be claimed and the session does not exist', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(null)

    const result = await registerForSession(999, input)

    expect(result).toEqual({ kind: 'not_found' })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('propagates unexpected errors', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockCreate.mockRejectedValue(new Error('db down'))

    await expect(registerForSession(1, input)).rejects.toThrow('db down')
  })

  it('runs registration transactions one at a time', async () => {
    let releaseFirst: (value: { count: number }) => void = () => undefined
    mockUpdateMany
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValueOnce({ count: 1 })
    mockCreate.mockResolvedValue(createdRegistration)
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 20, registered: 6, waitlisted: 0 })
    mockTransaction.mockClear()

    const first = registerForSession(1, input)
    const second = registerForSession(1, input)
    await new Promise((resolve) => setImmediate(resolve))

    expect(mockTransaction).toHaveBeenCalledTimes(1)

    releaseFirst({ count: 1 })
    await expect(first).resolves.toMatchObject({ kind: 'confirmed' })
    await expect(second).resolves.toMatchObject({ kind: 'confirmed' })
    expect(mockTransaction).toHaveBeenCalledTimes(2)
  })

  it('keeps processing registrations after one fails', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockCreate.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(createdRegistration)
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 20, registered: 6, waitlisted: 0 })

    const first = registerForSession(1, input)
    const second = registerForSession(1, input)

    await expect(first).rejects.toThrow('db down')
    await expect(second).resolves.toMatchObject({ kind: 'confirmed' })
  })
})

describe('cancelRegistration', () => {
  it('cancels a confirmed registration, decrements registered, and returns updated availability', async () => {
    mockRegFindFirst.mockResolvedValue(createdRegistration)
    mockRegUpdate.mockResolvedValue({ ...createdRegistration, status: 'cancelled' })
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 20, registered: 5, waitlisted: 0 })
    mockTransaction.mockClear()

    const result: CancelResult = await cancelRegistration(1, 42)

    expect(result).toEqual({
      kind: 'cancelled',
      session: { id: 1, capacity: 20, registered: 5, waitlisted: 0 },
    })
    expect(mockTransaction).toHaveBeenCalled()
    expect(mockRegFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42, sessionId: 1 } })
    )
    expect(mockRegUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 }, data: { status: 'cancelled' } })
    )
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 1, registered: { gt: 0 } },
      data: { registered: { decrement: 1 } },
    })
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 1 }, select: availabilitySelect })
  })

  it('cancels a waitlisted registration and decrements waitlisted instead of registered', async () => {
    mockRegFindFirst.mockResolvedValue(waitlistedRegistration)
    mockRegUpdate.mockResolvedValue({ ...waitlistedRegistration, status: 'cancelled' })
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 2, registered: 2, waitlisted: 0 })

    const result = await cancelRegistration(1, 43)

    expect(result).toEqual({
      kind: 'cancelled',
      session: { id: 1, capacity: 2, registered: 2, waitlisted: 0 },
    })
    expect(mockRegUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 43 }, data: { status: 'cancelled' } })
    )
    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 1, waitlisted: { gt: 0 } },
      data: { waitlisted: { decrement: 1 } },
    })
  })

  it('serialises cancelRegistration with registerForSession', async () => {
    let releaseFirst: (value: { count: number }) => void = () => undefined
    mockUpdateMany
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValueOnce({ count: 1 })
    mockCreate.mockResolvedValue(createdRegistration)
    mockRegFindFirst.mockResolvedValue(createdRegistration)
    mockRegUpdate.mockResolvedValue({ ...createdRegistration, status: 'cancelled' })
    mockFindUnique
      .mockResolvedValueOnce({ id: 1, capacity: 20, registered: 6, waitlisted: 0 })
      .mockResolvedValueOnce({ id: 1, capacity: 20, registered: 5, waitlisted: 0 })
    mockTransaction.mockClear()

    const first = registerForSession(1, input)
    const second = cancelRegistration(1, 42)
    await new Promise((resolve) => setImmediate(resolve))

    expect(mockTransaction).toHaveBeenCalledTimes(1)

    releaseFirst({ count: 1 })
    await expect(first).resolves.toMatchObject({ kind: 'confirmed' })
    await expect(second).resolves.toMatchObject({ kind: 'cancelled' })
    expect(mockTransaction).toHaveBeenCalledTimes(2)
  })

  it('returns not_found without writes when the registration does not exist for the session', async () => {
    mockRegFindFirst.mockResolvedValue(null)
    const expected: CancelResult = { kind: 'not_found' }

    const result: CancelResult = await cancelRegistration(1, 999)

    expect(result).toEqual(expected)
    expect(mockRegFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 999, sessionId: 1 } })
    )
    expect(mockRegUpdate).not.toHaveBeenCalled()
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('returns already_cancelled without modifying counters when registration status is already cancelled', async () => {
    mockRegFindFirst.mockResolvedValue({ ...createdRegistration, status: 'cancelled' })
    const expected: CancelResult = { kind: 'already_cancelled' }

    const result: CancelResult = await cancelRegistration(1, 42)

    expect(result).toEqual(expected)
    expect(mockRegFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42, sessionId: 1 } })
    )
    expect(mockRegUpdate).not.toHaveBeenCalled()
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('propagates unexpected errors during cancellation', async () => {
    mockRegFindFirst.mockResolvedValue(createdRegistration)
    mockRegUpdate.mockRejectedValue(new Error('db down'))

    await expect(cancelRegistration(1, 42)).rejects.toThrow('db down')
  })

  it('triggers onConfirmedCancelled hook inside the transaction when a confirmed registration is cancelled', async () => {
    const callOrder: string[] = []
    mockRegFindFirst.mockResolvedValue(createdRegistration)
    mockRegUpdate.mockResolvedValue({ ...createdRegistration, status: 'cancelled' })
    mockUpdateMany.mockImplementation(async () => {
      callOrder.push('updateMany')
      return { count: 1 }
    })
    const hook = jest.fn<Promise<void>, [WaitlistPromotionContext]>()
    hook.mockImplementation(async () => {
      await Promise.resolve()
      callOrder.push('hook')
    })
    mockFindUnique.mockImplementation(async () => {
      callOrder.push('findUnique')
      return { id: 1, capacity: 20, registered: 5, waitlisted: 0 }
    })
    const onConfirmedCancelled: WaitlistPromotionHook = hook
    const options: CancelRegistrationOptions = { onConfirmedCancelled }
    mockTransaction.mockClear()

    const result = await cancelRegistration(1, 42, options)

    expect(result).toEqual({
      kind: 'cancelled',
      session: { id: 1, capacity: 20, registered: 5, waitlisted: 0 },
    })
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 1, registered: { gt: 0 } },
      data: { registered: { decrement: 1 } },
    })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith({
      tx: expect.anything(),
      sessionId: 1,
      cancelledRegistrationId: 42,
    })
    expect(callOrder).toEqual(['updateMany', 'hook', 'findUnique'])
  })

  it('does not trigger onConfirmedCancelled when a waitlisted registration is cancelled', async () => {
    mockRegFindFirst.mockResolvedValue(waitlistedRegistration)
    mockRegUpdate.mockResolvedValue({ ...waitlistedRegistration, status: 'cancelled' })
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 2, registered: 2, waitlisted: 0 })
    const hook = jest.fn<Promise<void>, [WaitlistPromotionContext]>().mockResolvedValue(undefined)

    const result = await cancelRegistration(1, 43, { onConfirmedCancelled: hook })

    expect(result).toEqual({
      kind: 'cancelled',
      session: { id: 1, capacity: 2, registered: 2, waitlisted: 0 },
    })
    expect(hook).not.toHaveBeenCalled()
  })

  it('does not trigger onConfirmedCancelled on not_found or already_cancelled', async () => {
    const hook = jest.fn<Promise<void>, [WaitlistPromotionContext]>().mockResolvedValue(undefined)

    mockRegFindFirst.mockResolvedValueOnce(null)
    const notFoundResult = await cancelRegistration(1, 999, { onConfirmedCancelled: hook })

    mockRegFindFirst.mockResolvedValueOnce({ ...createdRegistration, status: 'cancelled' })
    const alreadyCancelledResult = await cancelRegistration(1, 42, { onConfirmedCancelled: hook })

    expect(notFoundResult).toEqual({ kind: 'not_found' })
    expect(alreadyCancelledResult).toEqual({ kind: 'already_cancelled' })
    expect(hook).not.toHaveBeenCalled()
  })

  it('propagates errors thrown by onConfirmedCancelled so the transaction rolls back', async () => {
    mockRegFindFirst.mockResolvedValue(createdRegistration)
    mockRegUpdate.mockResolvedValue({ ...createdRegistration, status: 'cancelled' })
    mockUpdateMany.mockResolvedValue({ count: 1 })
    const hook = jest.fn<Promise<void>, [WaitlistPromotionContext]>()
    hook.mockRejectedValue(new Error('promotion failed'))

    await expect(cancelRegistration(1, 42, { onConfirmedCancelled: hook })).rejects.toThrow(
      'promotion failed'
    )
    expect(mockFindUnique).not.toHaveBeenCalled()
  })
})
