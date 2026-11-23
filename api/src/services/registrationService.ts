import type { Registration } from '@prisma/client'
import prisma from '../lib/prisma'

export interface RegistrationInput {
  name: string
  email: string
}

export interface SessionAvailability {
  id: number
  capacity: number
  registered: number
}

export type ValidationResult = { ok: true; value: RegistrationInput } | { ok: false; error: string }

export type RegisterResult =
  | { kind: 'created'; registration: Registration; session: SessionAvailability }
  | { kind: 'not_found' }
  | { kind: 'full' }

const REQUIRED_FIELDS_ERROR = 'name and email are required'

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function validateRegistrationInput(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: REQUIRED_FIELDS_ERROR }
  }

  const fields = body as Record<string, unknown>
  const name = nonBlankString(fields.name)
  const email = nonBlankString(fields.email)

  if (name === null || email === null) {
    return { ok: false, error: REQUIRED_FIELDS_ERROR }
  }

  return { ok: true, value: { name, email } }
}

export async function registerForSession(
  sessionId: number,
  input: RegistrationInput
): Promise<RegisterResult> {
  return prisma.$transaction(async (tx) => {
    // Write first: the conditional increment lets the database decide who gets the
    // last seat, and taking the write lock up front avoids SQLite read-then-upgrade
    // deadlocks between concurrent registrations.
    const claimed = await tx.trainingSession.updateMany({
      where: { id: sessionId, registered: { lt: prisma.trainingSession.fields.capacity } },
      data: { registered: { increment: 1 } },
    })

    if (claimed.count === 0) {
      const existing = await tx.trainingSession.findUnique({
        where: { id: sessionId },
        select: { id: true },
      })
      return existing ? { kind: 'full' } : { kind: 'not_found' }
    }

    const registration = await tx.registration.create({
      data: { sessionId, name: input.name, email: input.email },
    })

    const session = await tx.trainingSession.findUnique({
      where: { id: sessionId },
      select: { id: true, capacity: true, registered: true },
    })

    if (!session) {
      throw new Error('Session disappeared during registration')
    }

    return { kind: 'created', registration, session }
  })
}
