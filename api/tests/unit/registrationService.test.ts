import {
  registerForSession,
  validateRegistrationInput,
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
