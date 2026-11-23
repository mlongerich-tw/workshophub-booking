import { Router, IRouter, Request, Response } from 'express'
import {
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

export default router
