import { Router, IRouter, Request, Response } from 'express'
import {
  cancelRegistration,
  registerForSession,
  validateRegistrationInput,
  type RegisterResult,
  type RegistrationStatus,
} from '../services/registrationService'

type StoredRegistration = Extract<RegisterResult, { kind: 'confirmed' }>['registration']

function toRegistrationDto(registration: StoredRegistration, status: RegistrationStatus) {
  const { id, sessionId, name, email, createdAt } = registration
  return { id, sessionId, name, email, status, createdAt }
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

const router: IRouter = Router({ mergeParams: true })

router.post('/', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const sessionId = parseInt(req.params.id, 10)
    if (isNaN(sessionId)) {
      res.status(400).json({ error: 'Invalid session ID' })
      return
    }

    const parsed = validateRegistrationInput(req.body)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    const result = await registerForSession(sessionId, parsed.value)

    switch (result.kind) {
      case 'not_found':
        res.status(404).json({ error: 'Training session not found' })
        return
      case 'confirmed':
        res.status(201).json({
          status: 'confirmed',
          registration: toRegistrationDto(result.registration, 'confirmed'),
          session: result.session,
        })
        return
      case 'waitlisted':
        res.status(202).json({
          status: 'waitlisted',
          position: result.position,
          registration: toRegistrationDto(result.registration, 'waitlisted'),
          session: result.session,
        })
        return
      default: {
        const unreachable: never = result
        throw new Error(`Unhandled registration result: ${JSON.stringify(unreachable)}`)
      }
    }
  } catch (error) {
    console.error('Error creating registration:', error)
    res.status(500).json({ error: 'Failed to create registration' })
  }
})

router.delete(
  '/:registrationId',
  async (req: Request<{ id: string; registrationId: string }>, res: Response) => {
    try {
      const sessionId = parsePositiveInt(req.params.id)
      if (sessionId === null) {
        res.status(400).json({ error: 'Invalid session ID' })
        return
      }

      const registrationId = parsePositiveInt(req.params.registrationId)
      if (registrationId === null) {
        res.status(400).json({ error: 'Invalid registration ID' })
        return
      }

      const result = await cancelRegistration(sessionId, registrationId)

      switch (result.kind) {
        case 'not_found':
          res.status(404).json({ error: 'Registration not found' })
          return
        case 'already_cancelled':
          res.status(409).json({ error: 'Registration is already cancelled' })
          return
        case 'cancelled':
          res.status(200).json({ status: 'cancelled', session: result.session })
          return
        default: {
          const unreachable: never = result
          throw new Error(`Unhandled cancellation result: ${JSON.stringify(unreachable)}`)
        }
      }
    } catch (error) {
      console.error('Error cancelling registration:', error)
      res.status(500).json({ error: 'Failed to cancel registration' })
    }
  }
)

export default router
