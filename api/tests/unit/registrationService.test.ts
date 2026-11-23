import {
  registerForSession,
  validateRegistrationInput,
} from '../../src/services/registrationService'
import prisma from '../../src/lib/prisma'

jest.mock('../../src/lib/prisma', () => {
  const client = {
    trainingSession: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      fields: { capacity: 'capacity-field-ref' },
    },
    registration: {
      create: jest.fn(),
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
const mockCreate = prisma.registration.create as jest.Mock
const mockTransaction = prisma.$transaction as jest.Mock

const input = { name: 'Ada Lovelace', email: 'ada@example.com' }

const createdRegistration = {
  id: 42,
  sessionId: 1,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  createdAt: new Date('2026-11-23T05:00:00Z'),
}

afterEach(() => {
  mockUpdateMany.mockReset()
  mockFindUnique.mockReset()
  mockCreate.mockReset()
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
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 20, registered: 6 })

    const result = await registerForSession(1, input)

    expect(result).toEqual({
      kind: 'created',
      registration: createdRegistration,
      session: { id: 1, capacity: 20, registered: 6 },
    })
    expect(mockTransaction).toHaveBeenCalled()
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 1, registered: { lt: 'capacity-field-ref' } },
      data: { registered: { increment: 1 } },
    })
    expect(mockCreate).toHaveBeenCalledWith({
      data: { sessionId: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
    })
  })

  it('returns full when no seat could be claimed and the session exists', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue({ id: 1 })

    const result = await registerForSession(1, input)

    expect(result).toEqual({ kind: 'full' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns not_found when no seat could be claimed and the session does not exist', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(null)

    const result = await registerForSession(999, input)

    expect(result).toEqual({ kind: 'not_found' })
    expect(mockCreate).not.toHaveBeenCalled()
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
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 20, registered: 6 })
    mockTransaction.mockClear()

    const first = registerForSession(1, input)
    const second = registerForSession(1, input)
    await new Promise((resolve) => setImmediate(resolve))

    expect(mockTransaction).toHaveBeenCalledTimes(1)

    releaseFirst({ count: 1 })
    await expect(first).resolves.toMatchObject({ kind: 'created' })
    await expect(second).resolves.toMatchObject({ kind: 'created' })
    expect(mockTransaction).toHaveBeenCalledTimes(2)
  })

  it('keeps processing registrations after one fails', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockCreate.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(createdRegistration)
    mockFindUnique.mockResolvedValue({ id: 1, capacity: 20, registered: 6 })

    const first = registerForSession(1, input)
    const second = registerForSession(1, input)

    await expect(first).rejects.toThrow('db down')
    await expect(second).resolves.toMatchObject({ kind: 'created' })
  })
})
