import type { Prisma, Registration } from '@prisma/client'
import prisma from '../lib/prisma'

export interface RegistrationInput {
  name: string
  email: string
}

export type RegistrationStatus = 'confirmed' | 'waitlisted' | 'cancelled'

export interface SessionAvailability {
  id: number
  capacity: number
  registered: number
  waitlisted: number
}

export type ValidationResult = { ok: true; value: RegistrationInput } | { ok: false; error: string }

export type RegisterResult =
  | { kind: 'confirmed'; registration: Registration; session: SessionAvailability }
  | {
      kind: 'waitlisted'
      registration: Registration
      position: number
      session: SessionAvailability
    }
  | { kind: 'not_found' }

export type CancelResult =
  | { kind: 'cancelled'; session: SessionAvailability }
  | { kind: 'not_found' }
  | { kind: 'already_cancelled' }

export interface WaitlistPromotionContext {
  tx: Prisma.TransactionClient
  sessionId: number
  cancelledRegistrationId: number
}

export type WaitlistPromotionHook = (context: WaitlistPromotionContext) => Promise<void> | void

export interface CancelRegistrationOptions {
  onConfirmedCancelled?: WaitlistPromotionHook
}

const noopWaitlistPromotion: WaitlistPromotionHook = () => undefined

const AVAILABILITY_SELECT = {
  id: true,
  capacity: true,
  registered: true,
  waitlisted: true,
} as const

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

// Registration transactions run one at a time per process. With SQLite, concurrent
// interactive transactions block Prisma's engine threads in the busy-wait, which can
// starve the lock holder on low-CPU machines until every request times out. The
// conditional increment below remains the capacity guarantee; this only avoids the
// starvation.
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

export async function registerForSession(
  sessionId: number,
  input: RegistrationInput
): Promise<RegisterResult> {
  return serialize(() => claimSeatOrWaitlist(sessionId, input))
}

async function claimSeatOrWaitlist(
  sessionId: number,
  input: RegistrationInput
): Promise<RegisterResult> {
  return prisma.$transaction(async (tx) => {
    // Write first: the conditional increment lets the database decide who gets the
    // last seat, and taking the write lock up front avoids SQLite read-then-upgrade
    // deadlocks between concurrent registrations. The waitlist path below runs in
    // the same serialised transaction, which is what keeps positions unique.
    const claimed = await tx.trainingSession.updateMany({
      where: { id: sessionId, registered: { lt: prisma.trainingSession.fields.capacity } },
      data: { registered: { increment: 1 } },
    })

    if (claimed.count > 0) {
      const registration = await tx.registration.create({
        data: { sessionId, name: input.name, email: input.email, status: 'confirmed' },
      })

      const session = await tx.trainingSession.findUnique({
        where: { id: sessionId },
        select: AVAILABILITY_SELECT,
      })

      if (!session) {
        throw new Error('Session disappeared during registration')
      }

      return { kind: 'confirmed', registration, session }
    }

    const existing = await tx.trainingSession.findUnique({
      where: { id: sessionId },
      select: { id: true },
    })
    if (!existing) {
      return { kind: 'not_found' }
    }

    const session = await tx.trainingSession.update({
      where: { id: sessionId },
      data: { waitlisted: { increment: 1 } },
      select: AVAILABILITY_SELECT,
    })

    const registration = await tx.registration.create({
      data: { sessionId, name: input.name, email: input.email, status: 'waitlisted' },
    })

    // Position is counted, not stored, so it stays correct once earlier entries
    // leave the waitlist (cancellation or promotion). Autoincrement ids give a
    // strict arrival order where timestamps could tie.
    const position = await tx.registration.count({
      where: { sessionId, status: 'waitlisted', id: { lte: registration.id } },
    })

    return { kind: 'waitlisted', registration, position, session }
  })
}

export async function cancelRegistration(
  sessionId: number,
  registrationId: number,
  options?: CancelRegistrationOptions
): Promise<CancelResult> {
  const onConfirmedCancelled = options?.onConfirmedCancelled ?? noopWaitlistPromotion
  return serialize(() => cancelRegistrationTx(sessionId, registrationId, onConfirmedCancelled))
}

async function cancelRegistrationTx(
  sessionId: number,
  registrationId: number,
  onConfirmedCancelled: WaitlistPromotionHook
): Promise<CancelResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.registration.findFirst({
      where: { id: registrationId, sessionId },
    })

    if (!existing) {
      return { kind: 'not_found' }
    }

    if (existing.status === 'cancelled') {
      return { kind: 'already_cancelled' }
    }

    await tx.registration.update({
      where: { id: existing.id },
      data: { status: 'cancelled' },
    })

    if (existing.status === 'confirmed') {
      await tx.trainingSession.updateMany({
        where: { id: sessionId, registered: { gt: 0 } },
        data: { registered: { decrement: 1 } },
      })

      // Run inside the transaction before reading final session availability so WH-5
      // waitlist promotion executes atomically and returned counts reflect promotion.
      await onConfirmedCancelled({ tx, sessionId, cancelledRegistrationId: existing.id })
    } else if (existing.status === 'waitlisted') {
      await tx.trainingSession.updateMany({
        where: { id: sessionId, waitlisted: { gt: 0 } },
        data: { waitlisted: { decrement: 1 } },
      })
    }

    const session = await tx.trainingSession.findUnique({
      where: { id: sessionId },
      select: AVAILABILITY_SELECT,
    })

    if (!session) {
      throw new Error('Session disappeared during cancellation')
    }

    return { kind: 'cancelled', session }
  })
}
