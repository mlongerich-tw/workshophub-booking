import request from 'supertest'
import app from '../../src/app'
import prisma from '../../src/lib/prisma'

const createdSessionIds: number[] = []

async function createSession(capacity: number, registered: number): Promise<number> {
  const session = await prisma.trainingSession.create({
    data: {
      title: `LATC-64 test ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: 'Integration test fixture',
      date: new Date('2030-01-01T09:00:00Z'),
      capacity,
      registered,
      location: 'Test Room',
      deliveryMode: 'online',
    },
  })
  createdSessionIds.push(session.id)
  return session.id
}

async function registrationCount(sessionId: number): Promise<number> {
  return prisma.registration.count({ where: { sessionId } })
}

async function registeredCount(sessionId: number): Promise<number | undefined> {
  const session = await prisma.trainingSession.findUnique({ where: { id: sessionId } })
  return session?.registered
}

async function waitlistedCount(sessionId: number): Promise<number | undefined> {
  const session = await prisma.trainingSession.findUnique({ where: { id: sessionId } })
  return session?.waitlisted
}

async function statusesFor(sessionId: number): Promise<string[]> {
  const rows = await prisma.registration.findMany({
    where: { sessionId },
    orderBy: { id: 'asc' },
    select: { status: true },
  })
  return rows.map((row) => row.status)
}

function positionsOf(responses: { status: number; body: { position?: unknown } }[]): unknown[] {
  return responses
    .filter((r) => r.status === 202)
    .map((r) => r.body.position)
    .sort((a, b) => Number(a) - Number(b))
}

function postRegistration(sessionId: number | string, body: object) {
  return request(app).post(`/api/training-sessions/${sessionId}/registrations`).send(body)
}

function deleteRegistration(sessionId: number | string, registrationId: number | string) {
  return request(app).delete(`/api/training-sessions/${sessionId}/registrations/${registrationId}`)
}

afterEach(async () => {
  const ids = createdSessionIds.splice(0)
  await prisma.registration.deleteMany({ where: { sessionId: { in: ids } } })
  await prisma.trainingSession.deleteMany({ where: { id: { in: ids } } })
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('POST /api/training-sessions/:id/registrations', () => {
  it('returns 201 with registration details and updated availability', async () => {
    const sessionId = await createSession(5, 0)

    const response = await postRegistration(sessionId, {
      name: ' Ada Lovelace ',
      email: ' ada@example.com ',
    })

    expect(response.status).toBe(201)
    expect(response.body.status).toBe('confirmed')
    expect(typeof response.body.registration.id).toBe('number')
    expect(response.body.registration).toMatchObject({
      sessionId,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      status: 'confirmed',
    })
    expect(response.body.registration.createdAt).toBeDefined()
    expect(response.body.session).toEqual({
      id: sessionId,
      capacity: 5,
      registered: 1,
      waitlisted: 0,
    })
    expect(await statusesFor(sessionId)).toEqual(['confirmed'])
  })

  it('increments the registered count after a successful registration', async () => {
    const sessionId = await createSession(5, 0)

    await postRegistration(sessionId, { name: 'Ada', email: 'ada@example.com' })

    const detail = await request(app).get(`/api/training-sessions/${sessionId}`)
    expect(detail.body.registered).toBe(1)
    expect(await registrationCount(sessionId)).toBe(1)
  })

  it('returns 400 when required fields are missing', async () => {
    const sessionId = await createSession(5, 0)

    const response = await postRegistration(sessionId, {})

    expect(response.status).toBe(400)
    expect(response.body.error).toBeDefined()
    expect(await registeredCount(sessionId)).toBe(0)
    expect(await registrationCount(sessionId)).toBe(0)
  })

  it('returns 400 when fields are blank or not strings', async () => {
    const sessionId = await createSession(5, 0)

    const blank = await postRegistration(sessionId, { name: '  ', email: 'a@b.c' })
    const wrongType = await postRegistration(sessionId, { name: 'Ada', email: 42 })

    expect(blank.status).toBe(400)
    expect(wrongType.status).toBe(400)
    expect(await registrationCount(sessionId)).toBe(0)
  })

  it('returns 400 for a non-numeric session id', async () => {
    const response = await postRegistration('abc', { name: 'Ada', email: 'a@b.c' })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Invalid session ID')
  })

  it('returns 404 when the session does not exist', async () => {
    const sessionId = await createSession(5, 0)
    await prisma.trainingSession.delete({ where: { id: sessionId } })

    const response = await postRegistration(sessionId, { name: 'Ada', email: 'a@b.c' })

    expect(response.status).toBe(404)
    expect(response.body.error).toBeDefined()
    expect(await registrationCount(sessionId)).toBe(0)
  })

  it('returns 202 and adds the employee to the waitlist when full', async () => {
    const sessionId = await createSession(2, 2)

    const response = await postRegistration(sessionId, { name: 'Ada', email: 'a@b.c' })

    expect(response.status).toBe(202)
    expect(response.body.status).toBe('waitlisted')
    expect(response.body.position).toBe(1)
    expect(typeof response.body.registration.id).toBe('number')
    expect(response.body.registration).toMatchObject({ sessionId, status: 'waitlisted' })
    expect(response.body.session).toEqual({
      id: sessionId,
      capacity: 2,
      registered: 2,
      waitlisted: 1,
    })
    expect(await registeredCount(sessionId)).toBe(2)
    expect(await waitlistedCount(sessionId)).toBe(1)
    expect(await statusesFor(sessionId)).toEqual(['waitlisted'])
  })

  it('assigns waitlist positions in arrival order', async () => {
    const sessionId = await createSession(1, 1)

    const first = await postRegistration(sessionId, { name: 'Ada', email: 'a@b.c' })
    const second = await postRegistration(sessionId, { name: 'Grace', email: 'g@b.c' })

    expect(first.status).toBe(202)
    expect(first.body.position).toBe(1)
    expect(second.status).toBe(202)
    expect(second.body.position).toBe(2)
    expect(await waitlistedCount(sessionId)).toBe(2)
  })

  it('waitlists registrations for a session with zero capacity', async () => {
    const sessionId = await createSession(0, 0)

    const response = await postRegistration(sessionId, { name: 'Ada', email: 'a@b.c' })

    expect(response.status).toBe(202)
    expect(response.body.position).toBe(1)
    expect(await registeredCount(sessionId)).toBe(0)
  })

  it('tracks waitlisted separately from registered', async () => {
    const sessionId = await createSession(1, 0)

    for (let i = 0; i < 3; i++) {
      await postRegistration(sessionId, { name: `Employee ${i}`, email: `e${i}@example.com` })
    }

    expect(await registeredCount(sessionId)).toBe(1)
    expect(await waitlistedCount(sessionId)).toBe(2)
    expect(await statusesFor(sessionId)).toEqual(['confirmed', 'waitlisted', 'waitlisted'])
  })

  it('gives the last seat to exactly one of several concurrent requests', async () => {
    const sessionId = await createSession(1, 0)

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postRegistration(sessionId, { name: `Employee ${i}`, email: `e${i}@example.com` })
      )
    )

    const statuses = responses.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 202, 202, 202, 202])
    expect(positionsOf(responses)).toEqual([1, 2, 3, 4])
    expect(await registeredCount(sessionId)).toBe(1)
    expect(await waitlistedCount(sessionId)).toBe(4)
    const stored = await statusesFor(sessionId)
    expect(stored.filter((s) => s === 'confirmed')).toHaveLength(1)
    expect(stored.filter((s) => s === 'waitlisted')).toHaveLength(4)
  })

  it('gives unique positions to concurrent waitlist joins', async () => {
    const sessionId = await createSession(1, 1)

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postRegistration(sessionId, { name: `Employee ${i}`, email: `e${i}@example.com` })
      )
    )

    expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202, 202])
    expect(positionsOf(responses)).toEqual([1, 2, 3, 4, 5])
    expect(await waitlistedCount(sessionId)).toBe(5)
    expect(await registeredCount(sessionId)).toBe(1)
  })
})

describe('DELETE /api/training-sessions/:id/registrations/:registrationId', () => {
  it('returns 200 with status cancelled, marks registration cancelled in DB, and decrements registered count', async () => {
    const sessionId = await createSession(5, 0)
    const created = await postRegistration(sessionId, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    const registrationId: number = created.body.registration.id

    const response = await deleteRegistration(sessionId, registrationId)

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('cancelled')
    expect(response.body.session).toEqual({
      id: sessionId,
      capacity: 5,
      registered: 0,
      waitlisted: 0,
    })
    const stored = await prisma.registration.findUnique({ where: { id: registrationId } })
    expect(stored?.status).toBe('cancelled')
    expect(await registeredCount(sessionId)).toBe(0)
    const detail = await request(app).get(`/api/training-sessions/${sessionId}`)
    expect(detail.status).toBe(200)
    expect(detail.body.registered).toBe(0)
  })

  it('cancels a waitlisted registration without decrementing registered', async () => {
    const sessionId = await createSession(1, 0)
    await postRegistration(sessionId, { name: 'Ada', email: 'ada@example.com' })
    const waitlisted = await postRegistration(sessionId, {
      name: 'Grace',
      email: 'grace@example.com',
    })
    const waitlistedId: number = waitlisted.body.registration.id

    const response = await deleteRegistration(sessionId, waitlistedId)

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('cancelled')
    expect(response.body.session).toEqual({
      id: sessionId,
      capacity: 1,
      registered: 1,
      waitlisted: 0,
    })
    expect(await registeredCount(sessionId)).toBe(1)
    expect(await waitlistedCount(sessionId)).toBe(0)
    expect(await statusesFor(sessionId)).toEqual(['confirmed', 'cancelled'])
  })

  it('returns 400 for a non-numeric session id or registration id on DELETE', async () => {
    const sessionId = await createSession(5, 0)

    const badSession = await deleteRegistration('abc', 1)
    const badRegistration = await deleteRegistration(sessionId, 'xyz')

    expect(badSession.status).toBe(400)
    expect(badSession.body.error).toBe('Invalid session ID')
    expect(badRegistration.status).toBe(400)
    expect(badRegistration.body.error).toBe('Invalid registration ID')
  })

  it('returns 404 when the registration does not exist', async () => {
    const sessionId = await createSession(5, 0)

    const response = await deleteRegistration(sessionId, 999999)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Registration not found' })
    expect(await registeredCount(sessionId)).toBe(0)
  })

  it('returns 404 when the registration belongs to a different session', async () => {
    const sessionA = await createSession(5, 0)
    const sessionB = await createSession(5, 0)
    const created = await postRegistration(sessionA, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    const regId: number = created.body.registration.id

    const response = await deleteRegistration(sessionB, regId)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Registration not found' })
    const stored = await prisma.registration.findUnique({ where: { id: regId } })
    expect(stored?.status).toBe('confirmed')
    expect(await registeredCount(sessionA)).toBe(1)
  })

  it('returns 404 when the session does not exist', async () => {
    const sessionId = await createSession(5, 0)
    await prisma.trainingSession.delete({ where: { id: sessionId } })

    const response = await deleteRegistration(sessionId, 1)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Registration not found' })
  })

  it('returns 409 when cancelling an already-cancelled registration', async () => {
    const sessionId = await createSession(5, 0)
    const created = await postRegistration(sessionId, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    const registrationId: number = created.body.registration.id

    const first = await deleteRegistration(sessionId, registrationId)
    expect(first.status).toBe(200)
    expect(first.body.session.registered).toBe(0)

    const second = await deleteRegistration(sessionId, registrationId)

    expect(second.status).toBe(409)
    expect(second.body).toEqual({ error: 'Registration is already cancelled' })
    const stored = await prisma.registration.findUnique({ where: { id: registrationId } })
    expect(stored?.status).toBe('cancelled')
    expect(await registeredCount(sessionId)).toBe(0)
  })

  it('handles concurrent duplicate cancellations without double-decrementing', async () => {
    const sessionId = await createSession(5, 0)
    const first = await postRegistration(sessionId, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    await postRegistration(sessionId, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
    })
    const firstId: number = first.body.registration.id
    expect(await registeredCount(sessionId)).toBe(2)

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => deleteRegistration(sessionId, firstId))
    )

    const statuses = responses.map((r) => r.status).sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409, 409, 409, 409])
    for (const conflict of responses.filter((r) => r.status === 409)) {
      expect(conflict.body).toEqual({ error: 'Registration is already cancelled' })
    }
    expect(await registeredCount(sessionId)).toBe(1)
    const stored = await statusesFor(sessionId)
    expect(stored.filter((s) => s === 'confirmed')).toHaveLength(1)
    expect(stored.filter((s) => s === 'cancelled')).toHaveLength(1)
  })

  it('keeps capacity and counts consistent when cancellation and booking run concurrently', async () => {
    const sessionId = await createSession(1, 0)
    const first = await postRegistration(sessionId, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    const firstId: number = first.body.registration.id
    expect(await registeredCount(sessionId)).toBe(1)

    const [cancelResponse, ...postResponses] = await Promise.all([
      deleteRegistration(sessionId, firstId),
      postRegistration(sessionId, { name: 'Grace Hopper', email: 'grace@example.com' }),
      postRegistration(sessionId, { name: 'Alan Turing', email: 'alan@example.com' }),
      postRegistration(sessionId, { name: 'Katherine Johnson', email: 'katherine@example.com' }),
    ])

    expect(cancelResponse.status).toBe(200)
    for (const res of postResponses) {
      expect([201, 202]).toContain(res.status)
    }

    const confirmedPosts = postResponses.filter((r) => r.status === 201).length
    const waitlistedPosts = postResponses.filter((r) => r.status === 202).length
    expect(confirmedPosts + waitlistedPosts).toBe(3)

    const stored = await statusesFor(sessionId)
    const confirmedRowCount = stored.filter((s) => s === 'confirmed').length
    const waitlistedRowCount = stored.filter((s) => s === 'waitlisted').length
    const cancelledRowCount = stored.filter((s) => s === 'cancelled').length
    const registered = await registeredCount(sessionId)
    const waitlisted = await waitlistedCount(sessionId)

    expect(cancelledRowCount).toBe(1)
    expect(confirmedRowCount).toBe(confirmedPosts)
    expect(waitlistedRowCount).toBe(waitlistedPosts)
    expect(registered).toBeGreaterThanOrEqual(0)
    expect(registered).toBeLessThanOrEqual(1)
    expect(waitlisted).toBeGreaterThanOrEqual(0)
    expect(registered).toBe(confirmedRowCount)
    expect(waitlisted).toBe(waitlistedRowCount)
  })
})
